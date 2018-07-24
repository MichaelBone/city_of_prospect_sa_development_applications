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
let didyoumean = require("didyoumean2");
let fs = require("fs");

const DevelopmentApplicationsUrl = "http://www.prospect.sa.gov.au/developmentregister";
const CommentUrl = "mailto:admin@prospect.sa.gov.au";

// Heights and widths used when recognising text in an image.

const LineHeight = 15;  // the tallest line of text is approximately 15 pixels high
const SectionHeight = LineHeight * 2;  // the text will be examined in sections this height (in pixels)
const SectionStep = 5;  // the next section of text examined will be offset vertically this number of pixels
const ColumnGap = LineHeight * 3;  // the horizontal gap between columns is always larger than about three line heights
const ColumnAlignment = 10;  // text above or below within this number of horizontal pixels is considered to be aligned at the start of a column

// All street and suburb names (used when correcting addresses).

let AllStreetNames = null;
let AllSuburbNames = null;

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

// Formats addresses, correcting any minor spelling errors.  An address is expected to be in the
// following format:
//
//     <StreetNumber> <StreetName> <SuburbName> <StateAbbreviation> <PostCode>
//
// where,
//
//     <StreetNumber> may contain digits, dashes and slashes (with no spaces)
//     <StreetName> is in mixed case and may contain spaces
//     <SuburbName> is in all uppercase and may contain spaces
//     <StateAbbreviation> is in all uppercase and may not contain spaces
//     <PostCode> is four digits and may not contain spaces
//
// for example,
//
//     2/121-130A Main North Road MEDINDIE GARDENS SA 5083

function formatAddress(address) {
    let tokens = address.trim().split(/\s+/);
    
    // Extract the street number at the start and the state abbreviation and post code at the end.

    if (tokens.length < 3)
        return address;

    let streetNumber = tokens[0];
    let stateAbbreviation = tokens[tokens.length - 2];
    let postCode = tokens[tokens.length - 1];

    if (stateAbbreviation.length === 0 || !/^[0-9][0-9][0-9][0-9]$/.test(postCode))
        return address;

    // Extract all mixed case words of the street name.

    let index = 1;
    let streetNameTokens = [];
    for (; index < tokens.length - 2 && (tokens[index].length === 1 || tokens[index] !== tokens[index].toUpperCase()); index++)
        streetNameTokens.push(tokens[index]);
    if (streetNameTokens.length === 0)
        return address;

    // Extract any remaining words as the suburb name.

    let suburbNameTokens = [];
    for (; index < tokens.length - 2; index++)
        suburbNameTokens.push(tokens[index]);
    if (suburbNameTokens.length === 0)
        return address;

    // Attempt to correct the street and suburb name (only allow a small amount of change because
    // otherwise a valid street name such as "Churcher" could be accidentally converted to another
    // equally valid street name such as "Church").

    let hasCorrections = false;
    let streetName = streetNameTokens.join(" ");
    let suburbName = suburbNameTokens.join(" ");

    let correctedStreetName = didyoumean(streetName, AllStreetNames, { caseSensitive: true, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
    if (correctedStreetName !== null && correctedStreetName !== streetName) {
        console.log(`Changing "${streetName}" to "${correctedStreetName}" in "${address.trim()}".`);
        streetName = correctedStreetName;
        hasCorrections = true;
    }

    let correctedSuburbName = didyoumean(suburbName, AllSuburbNames, { caseSensitive: true, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
    if (correctedSuburbName !== null && correctedSuburbName !== suburbName) {
        console.log(`Changing "${suburbName}" to "${correctedSuburbName}" in "${address.trim()}".`);
        suburbName = correctedSuburbName;
        hasCorrections = true;
    }

    if (!hasCorrections)
        return address;

    // Reconstruct the corrected address.

    return streetNumber + " " + streetName + " " + suburbName + " " + stateAbbreviation + " " + postCode;
}

// Choose the development applications that have the highest confidence value.

function chooseDevelopmentApplications(candidateDevelopmentApplications) {
    // Where there are multiple candidate development applications (with the same application
    // number) choose the development application with the highest total confidence.

    let developmentApplications = {};

    for (let candidateDevelopmentApplication of candidateDevelopmentApplications) {
        let developmentApplication = developmentApplications[candidateDevelopmentApplication.applicationNumber];
        if (developmentApplication === undefined || (developmentApplication !== undefined && developmentApplication.confidence < candidateDevelopmentApplication.confidence))
            developmentApplications[candidateDevelopmentApplication.applicationNumber] = candidateDevelopmentApplication;
    }

    return developmentApplications;
}

// Parses the lines of words.  Each word in a line consists of a bounding box, the text that
// exists in that bounding box and the confidence information determined by tesseract.js.  The
// logic here also performs partitioning of the text into columns (for example, the description
// and address columns).

function parseLines(pdfUrl, lines) {
    // Exclude lines that have low confidence or do not start with the expected text.

    let filteredLines = [];
    for (let line of lines) {
        // Exclude lines that have low confidence (ie. any word with less than 80% confidence;
        // the choice of 80% is an arbitrary choice, it is intended to exclude lines where the
        // sectioning of the image has resulted in a line being cut in half horizontally).

        if (line.filter(word => word.confidence < 80).length > 0)  // 80% confidence
            continue;

        // Exclude lines that do not start with an application number and date.

        if (line.length < 2 || !moment(line[0].text.trim(), "D/MM/YYYY", true).isValid() || !isApplicationNumber(line[1].text.trim()))
            continue;

        filteredLines.push(line);
    }

    // Determine where the description, applicant and address are located on each line.  This is
    // partly determined by looking for the sizable gaps between columns.

    let columns = [];
    for (let filteredLine of filteredLines) {
        let previousWord = null;
        for (let word of filteredLine) {
            if (previousWord === null || word.bounds.x - (previousWord.bounds.x + previousWord.bounds.width) >= ColumnGap) {
                // Found the potential start of another column (count how many times this occurs
                // at the current X co-ordinate; the more times the more likely it is that this
                // is actually the start of a column).

                let closestColumn = columns.find(column => Math.abs(word.bounds.x - column.x) < ColumnAlignment);
                if (closestColumn !== undefined)
                    closestColumn.count++;
                else
                    columns.push({ x: word.bounds.x, count: 1 });
            }
            previousWord = word;
        }
    }

    // Ignore columns that have low counts.

    let totalCount = 0;
    for (let column of columns)
        totalCount += column.count;
    let averageCount = totalCount / Math.max(1, columns.length);
    columns = columns.filter(column => column.count > averageCount / 2);  // low counts indicate low likelihood of the start of a column (arbitrarily use the average count divided by two as a threshold)
    columns.sort((column1, column2) => (column1.x > column2.x) ? 1 : ((column1.x < column2.x) ? -1 : 0));

    // Assume that there are five columns: date, application number, description, applicant and
    // address.

    let candidateDevelopmentApplications = [];
    for (let filteredLine of filteredLines) {
        let description = "";
        let applicant = "";  // this is currently not used (but extracted for completeness)
        let address = "";
        let isDescription = true;
        let isApplicant = false;
        let isAddress = false;
        let previousWord = null;
        let confidence = 0;

        for (let index = 2; index < filteredLine.length; index++) {  // ignore the first two columns (assumed to be the date and application number)
            let word = filteredLine[index];
            confidence += word.confidence;

            // Determine if this word lines up with the start of a column, or if there is a sizable
            // gap between this word and the last.  In either case assume the next column has been
            // encountered (keeping in mind that there are five columns: date, application number,
            // description, applicant and address).

            let column = columns.find(column => Math.abs(column.x - word.bounds.x) < ColumnAlignment);
            if (previousWord !== null && (word.bounds.x - (previousWord.bounds.x + previousWord.bounds.width) >= ColumnGap || column !== undefined)) {
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

        address = formatAddress(address);
        if (address.trim() === "")  // ensure that there actually is an address
            continue;

        candidateDevelopmentApplications.push({
            applicationNumber: filteredLine[1].text.trim(),
            address: address.trim(),
            reason: description.trim(),
            informationUrl: pdfUrl,
            commentUrl: CommentUrl,
            scrapeDate: moment().format("YYYY-MM-DD"),
            receivedDate: moment(filteredLine[0].text.trim(), "D/MM/YYYY", true).format("YYYY-MM-DD"),
            confidence: confidence });
    }

    // Where the same development application number appears multiple times, choose the development
    // application with the highest confidence value.  Application numbers often appear multiple
    // times because the image is examined step by step in overlapping "sections".

    return chooseDevelopmentApplications(candidateDevelopmentApplications);
}

// Determines whether the specified text represents an application number.  A strict format of
// "nnn/nnn/nnnn", "nnn/nn/nnnn" or "nnn/n/nnnn" is assumed.  For example, "030/279/2018".

function isApplicationNumber(text) {
    return /^[0-9]{3}\/[0-9]{1,3}\/[0-9]{4}$/.test(text)
}

// Parses an image (from a PDF file).

async function parseImage(pdfUrl, image) {
    // The image is examined in overlapping sections to reduce the memory usage (there is currently
    // a hard limit of 512 MB when running in morph.io).

    let lines = [];

    console.log(`Image x is [0..${image.width - 1}], y is [0..${image.height - 1}].`);
    for (let sectionY = 0; sectionY < image.height; sectionY += SectionStep) {
        let sectionHeight = Math.min(image.height - sectionY, SectionHeight);
        console.log(`Examining y in [${sectionY}..${sectionY + sectionHeight - 1}] of [0..${image.height - 1}].`)

        // Convert the image data into a format that can be used by jimp.

        let jimpImage = new jimp(image.width, image.height);
        for (let x = 0; x < image.width; x++) {
            for (let y = 0; y < image.height; y++) {
                let index = (y * image.width * 3) + (x * 3);
                let color = jimp.rgbaToInt(image.data[index], image.data[index + 1], image.data[index + 2], 255);
                jimpImage.setPixelColor(color, x, y);
            }
        }

        // Attempt to remove any horizontal black lines (as these usually interfere with the
        // recognition of characters that have descenders such as "g", "j", "p", "q" and "y").

        let previousColors = null;
        for (let y = 0; y < image.height; y++) {
            // Count the number of dark pixels across the current horizontal line.

            let darkCount = 0;
            let colors = {};
            for (let x = 0; x < image.width; x++) {
                let value = jimpImage.getPixelColor(x, y);
                let color = jimp.intToRGBA(value);
                if (color.r < 64 && color.g < 64 && color.b < 64 && color.a >= 196)
                    darkCount++;
                colors[value] = (colors[value] || 0) + 1;
            }

            // If there are a lot of dark pixels then it is very likely a black line.  Set all
            // those pixels to the most common colour on the immediately previous line.

            if (darkCount >= image.width - 2 * ColumnGap && previousColors !== null) {
                // Find the most common colour on the immediately previous line.

                let previousColor = null;
                for (let color in previousColors)
                    if (previousColor === null || previousColors[color] > previousColors[previousColor])
                        previousColor = color;

                // Set the entire line to the most common colour of the immediately previous line.

                previousColor = Number(previousColor);
                for (let x = 0; x < image.width; x++)
                    jimpImage.setPixelColor(previousColor, x, y);
            }

            previousColors = colors;
        }

        // Grab a section of the image (this minimises memory usage) and upscale the section of
        // the image (because this significantly improves the OCR results, but also significantly
        // increases memory usage).

        jimpImage.crop(0, sectionY, image.width, sectionHeight).scale(6.0, jimp.RESIZE_BEZIER);
        let imageBuffer = await (new Promise((resolve, reject) => jimpImage.getBuffer(jimp.MIME_PNG, (error, buffer) => resolve(buffer))));

        // Perform OCR on the image (this is extremely memory and CPU intensive).

        let result = await new Promise((resolve, reject) => { tesseract.recognize(imageBuffer).then(function(result) { resolve(result); }) });

        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the current
        // process being terminated by morph.io).

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

    // Analyse the lines of words to extract development application details.

    return parseLines(pdfUrl, lines);
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
                let developmentApplications = await parseImage(pdfUrl, image);

                // Insert the resulting development applications into the database.

                for (let developmentApplication of developmentApplications)
                    await insertRow(database, developmentApplication);
            }
        }
    }
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Parses the development applications from the PDFs on the page.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Read the files containing all possible suburb and street names (these are used later when
    // correcting OCR text).

    AllStreetNames = fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n");
    AllSuburbNames = fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n");

    // Retrieve the page containing the links to the development application PDFs.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request(DevelopmentApplicationsUrl);
    let $ = cheerio.load(body);

    let pdfUrls = [];
    let linkElements = $("div.uContentList a[href$='.pdf']").get();

    if (linkElements.length === 0) {
        console.log("No PDFs were found.");
        return;
    }

    // Remove duplicate URLs.

    for (let linkElement of linkElements) {
        let pdfUrl = new urlparser.URL(linkElement.attribs.href, DevelopmentApplicationsUrl).href;
        if (pdfUrls.some(url => url === pdfUrl))
            continue;  // ignore duplicates
        pdfUrls.push(pdfUrl);
    }

    // Parse the most recent PDF and one other randomly selected PDF (do not parse all PDFs
    // because this would take too long: OCR is extremely memory and CPU intensive).

    let twoPdfUrls = [];
    twoPdfUrls.push(pdfUrls[0]);
    if (pdfUrls.length >= 2)
        twoPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);

    for (let pdfUrl of twoPdfUrls) {
        // Read the PDF containing an image of several development applications.  Note that setting
        // disableFontFace to true avoids a "document is not defined" exception that is otherwise
        // thrown in fontLoaderInsertRule.

        console.log(`Retrieving document: ${pdfUrl}`);
        let pdf = await pdfjs.getDocument({ url: pdfUrl, disableFontFace: true });
        await parsePdf(pdfUrl, pdf);  // this inserts development applications into the database
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
