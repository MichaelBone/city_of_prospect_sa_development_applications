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
        let page = await pdf.getPage(1);

        let operators = await page.getOperatorList();

        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] === pdfjs.OPS.paintImageXObject) {
                // Obtain the image data.

                let operator = operators.argsArray[index][0];
                let image = page.objs.get(operator);
                
                // The image is examined in overlapping windows to reduce the memory usage (there
                // is currently a hard limit of 512 MB).

                const WindowHeight = 13 * 2;  // a row of text is approximately 13 pixels high
                const WindowOverlap = 13;
                console.log(`Image width is ${image.width} and image height is ${image.height}.`);
                for (let windowY = 0; windowY < image.height; windowY += WindowHeight) {
                    // Convert the image data into a format that can be used by jimp.

                    let jimpImage = new jimp(image.width, image.height);
                    for (let x = 0; x < image.width; x++) {
                        for (let y = 0; y < image.height; y++) {
                            let index = (y * image.width * 3) + (x * 3);
                            let color = jimp.rgbaToInt(image.data[index], image.data[index + 1], image.data[index + 2], 255);
                            jimpImage.setPixelColor(color, x, y);
                        }
                    }

                    // Upscale the image (this improves the OCR results).

                    console.log(`Cropping and upscaling the image for (0, ${windowY}, ${image.width}, ${WindowHeight * 1.5}).`);
                    jimpImage.crop(0, windowY, image.width, Math.min(image.height - windowY, WindowHeight + WindowOverlap)).scale(5.0);

                    console.log("Examining the image.");
                    let imageBuffer = await (new Promise((resolve, reject) => jimpImage.getBuffer(jimp.MIME_PNG, (error, buffer) => resolve(buffer))));

                    try {
                        global.gc();
                    } catch (ex) {
                        console.log("Garbage collection not possible.");
                    }

                    let result = await new Promise((resolve, reject) => {
                        console.log("Calling recognize.");
                        tesseract.recognize(imageBuffer).then(function(result) {
                            resolve(result);
                        })
                    });
            
                    console.log(`text: ${result.text}`);
                    tesseract.terminate();

                    try {
                        global.gc();
                    } catch (ex) {
                        console.log("Garbage collection not possible.");
                    }
                }
                return;
            }
        }

        console.log("Just processing one PDF document at this stage.");
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
