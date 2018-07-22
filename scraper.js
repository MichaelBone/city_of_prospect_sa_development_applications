// Parses the development application at the South Australian City of Prospect web site and
// places them in a database.
//
// Michael Bone
// 19th July 2018

let cheerio = require("cheerio");
let request = require("request-promise-native");
let sqlite3 = require("sqlite3").verbose();
let urlparser = require("url");
let moment = require("moment");
let tesseract = require("tesseract.js");
let pdfjs = require("pdfjs-dist");
let jimp = require("jimp");

const DevelopmentApplicationsUrl = "http://www.prospect.sa.gov.au/developmentregister";
const CommentUrl = "mailto:admin@prospect.sa.gov.au";

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if it does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.reason,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            null,
            null
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted new application \"${developmentApplication.applicationNumber}\" into the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// Parses an image (from a PDF file).

async function parseImage(image) {
    // The image is examined in overlapping windows to reduce the memory usage (there is currently
    // a hard limit of 512 MB).

    const LineHeight = 15;  // the tallest text is approximately 15 pixels high
    const SectionHeight = LineHeight * 2;

    console.log(`Image x = [0..${image.width}], y = [0..${image.height}].`);
    for (let sectionY = 0; sectionY < image.height; sectionY += LineHeight / 3) {
        let sectionHeight = Math.min(image.height - sectionY, SectionHeight);
        console.log(`Examining y = [${sectionY}..${sectionY + sectionHeight - 1}] of ${image.height}.`)

        // Convert the image data into a format that can be used by jimp.

        let memoryUsage = process.memoryUsage();
        console.log(`    Memory Usage Before Images: rss: ${Math.round(memoryUsage.rss / (1024 * 1024))} MB, heapTotal: ${Math.round(memoryUsage.heapTotal / (1024 * 1024))} MB, heapUsed: ${Math.round(memoryUsage.heapUsed / (1024 * 1024))} MB, external: ${Math.round(memoryUsage.external / (1024 * 1024))} MB`);
        let jimpImage = new jimp(image.width, image.height);
        for (let x = 0; x < image.width; x++) {
            for (let y = 0; y < image.height; y++) {
                let index = (y * image.width * 3) + (x * 3);
                let color = jimp.rgbaToInt(image.data[index], image.data[index + 1], image.data[index + 2], 255);
                jimpImage.setPixelColor(color, x, y);
            }
        }

        // Grap a section of the image (this minimises memory usage and upscale it (this improves
        // the OCR results).

        jimpImage.crop(0, sectionY, image.width, sectionHeight).scale(7.0);
        let imageBuffer = await (new Promise((resolve, reject) => jimpImage.getBuffer(jimp.MIME_PNG, (error, buffer) => resolve(buffer))));

        // Perform OCR on the image.

        memoryUsage = process.memoryUsage();
        console.log(`     Memory Usage After Images: rss: ${Math.round(memoryUsage.rss / (1024 * 1024))} MB, heapTotal: ${Math.round(memoryUsage.heapTotal / (1024 * 1024))} MB, heapUsed: ${Math.round(memoryUsage.heapUsed / (1024 * 1024))} MB, external: ${Math.round(memoryUsage.external / (1024 * 1024))} MB`);
        let result = await new Promise((resolve, reject) => {
            tesseract.recognize(imageBuffer).then(function(result) {
                resolve(result);
            })
        });

        // Attempt to avoid reaching 512 MB memory usage.

        memoryUsage = process.memoryUsage();
        console.log(`Memory Usage: rss: ${Math.round(memoryUsage.rss / (1024 * 1024))} MB, heapTotal: ${Math.round(memoryUsage.heapTotal / (1024 * 1024))} MB, heapUsed: ${Math.round(memoryUsage.heapUsed / (1024 * 1024))} MB, external: ${Math.round(memoryUsage.external / (1024 * 1024))} MB`);
        tesseract.terminate();
        if (global.gc)
            global.gc();

        // Analyse the resulting text.

        if (result.blocks && result.blocks.length)
            for (let word of result.blocks[0].paragraphs[0].lines[0].words)
                console.log(`    ${word.text} (confidence: ${Math.round(word.confidence)}, choices: ${word.choices.length}, x0: ${word.bbox.x0})`);
    }
}

// Parses a single PDF file.

async function parsePdf(pdf) {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        console.log(`Examining page ${pageNumber} of ${pdf.numPages} in the PDF.`);

        let page = await pdf.getPage(pageNumber);
        let operators = await page.getOperatorList();

        // Find and parse any images in the PDF.

        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] === pdfjs.OPS.paintImageXObject) {
                let operator = operators.argsArray[index][0];
                let image = page.objs.get(operator);
                await parseImage(image);
            }
        }
    }
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Retrieve the page contain the link to the PDFs.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request(DevelopmentApplicationsUrl);
    let $ = cheerio.load(body);

    let pdfUrls = [];
    for (let element of $("div.uContentList a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
        if (pdfUrls.some(url => url === pdfUrl))
            continue;  // ignore duplicates
        pdfUrls.push(pdfUrl);

        // Read the PDF containing an image of several development applications.  Note that setting
        // disableFontFace to true avoids a "document is not defined" exception that is otherwise
        // thrown in fontLoaderInsertRule.

        console.log(`Retrieving document: ${pdfUrl}`);
        let pdf = await pdfjs.getDocument({ url: pdfUrl, disableFontFace: true });
        await parsePdf(pdf);
        console.log("Only examining the first PDF.");
        return;  // only examine one PDF file at this stage.
    }

    // let pdfUrl = new urlparser.URL(relativePdfUrl, DevelopmentApplicationsUrl)
    // console.log(`Retrieving document: ${pdfUrl.href}`);

    // Parse the PDF into a collection of PDF rows.
    
    // for (let row of rows) {
    //     let receivedDate = moment(row[3].trim(), "D/MM/YYYY", true);  // allows the leading zero of the day to be omitted
    //     await insertRow(database, {
    //         applicationNumber: row[2].trim(),
    //         address: row[1].trim(),
    //         reason: row[5].trim(),
    //         informationUrl: pdfUrl.href,
    //         commentUrl: CommentUrl,
    //         scrapeDate: moment().format("YYYY-MM-DD"),
    //         receivedDate: receivedDate.isValid ? receivedDate.format("YYYY-MM-DD") : ""
    //     });
    // }
}

// Determines whether the specified text represents an application number.  A strict format of
// "nn/n", "nn/nn", "nn/nnn" or "nn/nnnn" is assumed.  For example, "17/67" or "17/1231".

function isApplicationNumber(text) {
    return /^[0-9][0-9]\/[0-9]{1,4}$/.test(text)
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
