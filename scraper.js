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
let didyoumean2 = require("didyoumean2");

const DevelopmentApplicationsUrl = "http://www.prospect.sa.gov.au/developmentregister";
const CommentUrl = "mailto:admin@prospect.sa.gov.au";

// Heights used when recognising text in an image.

const LineHeight = 15;  // the tallest line of text is approximately 15 pixels high
const SectionHeight = LineHeight * 2;  // the text will be examined in sections this height (in pixels)
const SectionStep = 5;  // the next section of text examined will be offset vertically this number of pixels
const ColumnGap = LineHeight * 3;  // the horizontal gap between columns is always larger than about three line heights

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

function chooseDevelopmentApplications(developmentApplications) {

}

// Parses the lines of words.  Each word in a line consists of a bounding box, the text that exists
// in that bounding box and the confidence information determined by tesseract.js.

function parseLines(pdfUrl, lines) {
    // Exclude lines that have low confidence or do not start with the expected text.

    let filteredLines = []
    for (let line of lines) {
        // Exclude lines that have low confidence (ie. any word with less than 80% confidence;
        // the choice of 80% is an arbitrary choice, it is intended to exclude lines where the
        // sectioning of the image has resulted in a line being cut in half horizontally).

        if (line.filter(word => word.confidence < 80).length > 0)
            continue;

        // Exclude lines that do not start with an application number and date.

        if (line.length < 2 || !moment(line[0].text.trim(), "D/MM/YYYY", true).isValid() || !isApplicationNumber(line[1].text.trim()))
            continue;

        filteredLines.push(line);
    }

    // Determine where the description, applicant and address are located on each line.  There is
    // determined by looking for the sizable gaps between columns.

    let developmentApplications = [];
    for (let line of filteredLines) {
        let description = "";
        let applicant = "";
        let address = "";
        let isDescription = true;
        let isApplicant = false;
        let isAddress = false;
        let previousWord = null;
        let confidence = 0;
        for (let index = 2; index < line.length; index++) {
            let word = line[index];
            confidence += word.confidence;

            // Determine if there is a sizable gap between this word and the last.

            if (previousWord !== null && word.bounds.x - (previousWord.bounds.x + previousWord.bounds.width) >= ColumnGap) {
                if (isDescription) {
                    isDescription = false;
                    isApplicant = true;
                } else if (isApplicant) {
                    isApplicant = false;
                    isAddress = true;
                }
            }

            // Add the word to the currently determined column.

            if (isDescription)
                description += word.text + " ";
            else if (isApplicant)
                applicant += word.text + " ";
            else if (isAddress)
                address += word.text + " ";

            previousWord = word;
        }

        if (address.trim() !== "")
            developmentApplications.push({
                applicationNumber: line[1].text.trim(),
                address: address.trim(),
                reason: description.trim(),
                informationUrl: pdfUrl,
                commentUrl: CommentUrl,
                scrapeDate: moment().format("YYYY-MM-DD"),
                receivedDate: moment(line[0].text.trim(), "D/MM/YYYY", true).format("YYYY-MM-DD"),
                confidence: confidence });
    }

    return developmentApplications;
}

// Determines whether the specified text represents an application number.  A strict format of
// "nnn/nnn/nnnn" is assumed.  For example, "030/279/2018".

function isApplicationNumber(text) {
    return /^[0-9][0-9][0-9]\/[0-9][0-9][0-9]\/[0-9][0-9][0-9][0-9]$/.test(text)
}

// Parses an image (from a PDF file).

async function parseImage(pdfUrl, image) {
    // The image is examined in overlapping windows to reduce the memory usage (there is currently
    // a hard limit of 512 MB).

    let lines = [];

    console.log(`Image x = [0..${image.width}], y = [0..${image.height}].`);
    for (let sectionY = 0; sectionY < image.height; sectionY += SectionStep) {
        let sectionHeight = Math.min(image.height - sectionY, SectionHeight);
        console.log(`Examining y = [${sectionY}..${sectionY + sectionHeight - 1}] of ${image.height}.`)

        // Convert the image data into a format that can be used by jimp.

        let jimpImage = new jimp(image.width, image.height);
        for (let x = 0; x < image.width; x++) {
            for (let y = 0; y < image.height; y++) {
                let index = (y * image.width * 3) + (x * 3);
                let color = jimp.rgbaToInt(image.data[index], image.data[index + 1], image.data[index + 2], 255);
                jimpImage.setPixelColor(color, x, y);
            }
        }

        // Attempt to remove any horizontal black lines (as these interfere with recognition of
        // characters with descenders such as "g", "p", "q" and "y").

        let previousAverageColor = null;
        for (let y = 0; y < image.height; y++) {
            // Count the number of dark pixels across the current horizontal line.

            let blackCount = 0;
            let averageColor = { r: 0, g: 0, b: 0, a: 0 };
            for (let x = 0; x < image.width; x++) {
                let color = jimp.intToRGBA(jimpImage.getPixelColor(x, y));
                if (color.r < 64 && color.g < 64 && color.b < 64 && color.a >= 196)
                    blackCount++;
                averageColor.r += color.r;
                averageColor.g += color.g;
                averageColor.b += color.b;
                averageColor.a += color.a;
            }

            // If there are a lot of dark pixels then it is very likely a black line.  Set all
            // those pixels to the average colour of the immediately previous line.

            if (blackCount >= image.width - 2 * ColumnGap && previousAverageColor !== null) {
                let previousColor = jimp.rgbaToInt(previousAverageColor.r / image.width, previousAverageColor.g / image.width, previousAverageColor.b / image.width, previousAverageColor.a / image.width);
                for (let x = 0; x < image.width; x++)
                    jimpImage.setPixelColor(previousColor, x, y);
            }

            previousAverageColor = averageColor;
        }

        // Grap a section of the image (this minimises memory usage and upscale it (this improves
        // the OCR results).

        jimpImage.crop(0, sectionY, image.width, sectionHeight).scale(6.0, jimp.RESIZE_BEZIER);
        let imageBuffer = await (new Promise((resolve, reject) => jimpImage.getBuffer(jimp.MIME_PNG, (error, buffer) => resolve(buffer))));

        // Perform OCR on the image.

        let result = await new Promise((resolve, reject) => { tesseract.recognize(imageBuffer).then(function(result) { resolve(result); }) });

        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the current
        // process being terminated in morph.io).

        let memoryUsage = process.memoryUsage();
        console.log(`Memory Usage: rss: ${Math.round(memoryUsage.rss / (1024 * 1024))} MB, heapTotal: ${Math.round(memoryUsage.heapTotal / (1024 * 1024))} MB, heapUsed: ${Math.round(memoryUsage.heapUsed / (1024 * 1024))} MB, external: ${Math.round(memoryUsage.external / (1024 * 1024))} MB`);
        tesseract.terminate();
        if (global.gc)
            global.gc();

        // Simplify the lines.

        if (result.blocks && result.blocks.length)
            for (let block of result.blocks)
                for (let paragraph of block.paragraphs)
                    for (let line of paragraph.lines)
                        lines.push(line.words.map(word => { return { text: word.text, confidence: word.confidence, choices: word.choices.length, bounds: { x: word.bbox.x0, y: word.bbox.y0, width: word.bbox.x1 - word.bbox.x0, height: word.bbox.y1 - word.bbox.y0 } }; }));
    }

    // Analyse the lines of words.

    parseLines(pdfUrl, lines);
}

// Parses a single PDF file.

async function parsePdf(pdfUrl, pdf) {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        console.log(`Examining page ${pageNumber} of ${pdf.numPages} in the PDF.`);

        let page = await pdf.getPage(pageNumber);
        let operators = await page.getOperatorList();

        // Find and parse any images in the PDF.

        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] === pdfjs.OPS.paintImageXObject) {
                let operator = operators.argsArray[index][0];
                let image = page.objs.get(operator);
                await parseImage(pdfUrl, image);
            }
        }
    }
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

// let lines = JSON.parse("");
// await parseLines("http://test.com", lines);
// return;

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
        await parsePdf(pdfUrl, pdf);
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

main().then(() => console.log("Complete.")).catch(error => console.error(error));
