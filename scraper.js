// Parses the development application at the South Australian City of Prospect web site and
// places them in a database.
//
// Michael Bone
// 19th July 2018

"use strict";

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

const LineHeight = 15;  // the tallest line of text is approximately this many pixels high
const SectionHeight = LineHeight * 2;  // the text will be examined in sections of this height (in pixels)
const SectionStep = 5;  // the next section of text examined will be offset vertically this number of pixels
const ColumnGap = 15;  // the horizontal gap between columns is assumed to be larger than about 15 pixels
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
                    console.log(`    Application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" was inserted into the database.`);
                else
                    console.log(`    Application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and reason \"${developmentApplication.reason}\" was already present in the database.`);

                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// Chooses the development applications that have the highest confidence value (prioritising
// high confidence addresses).

function chooseDevelopmentApplications(developmentApplications) {
    // Group the development applications by address (since this is the most important
    // information).

    let groupedApplications = {};

    for (let developmentApplication of developmentApplications) {
        // For an address to be considered valid it must at least have a street name (possibly
        // not recognised) and a have a recognised suburb name.  Enforce that the development
        // application number contains at least one slash.  And enforce that the address text
        // has reasonably high confidence (at least 75%; this is an arbitrary value).

        if (!developmentApplication.hasStreet ||
            !developmentApplication.hasRecognizedSuburb || 
            developmentApplication.applicationNumber === "" ||
            developmentApplication.applicationNumber.indexOf("/") < 0 ||
            developmentApplication.addressConfidence < 75)
            continue;  // ignore the application

        let group = groupedApplications[developmentApplication.address];
        if (group === undefined)
            groupedApplications[developmentApplication.address] = (group = []);
        group.push(developmentApplication);
    }

    // Within each group of applications with the same address select the application with the
    // highest confidence address.  However, also prefer application numbers with two slashes.

    let chosenApplications = [];

    for (let address in groupedApplications) {
        // Choose the application with the highest confidence address in each group.

        let group = groupedApplications[address];
        let applicationWithBestAddress = group.reduce((a, b) => (a.addressConfidence > b.addressConfidence) ? a : b);

        // Choose the application with the highest confidence application number, however regard
        // applications that have slashes with higher confidence.  For example, this will choose
        // "077/586/2018" over "077/586l2018" (even if the first one has lower confidence).

        let applicationWithBestNumber = null;
        let twoSlashApplications = group.filter(application => application.applicationNumber.split("/").length - 1 === 2);
        if (twoSlashApplications.length > 0)
            applicationWithBestNumber = twoSlashApplications.reduce((a, b) => (a.applicationNumberConfidence > b.applicationNumberConfidence) ? a : b);
        else {
            let oneSlashApplications = group.filter(application => application.applicationNumber.split("/").length - 1 === 1);
            if (oneSlashApplications.length > 0)
                applicationWithBestNumber = oneSlashApplications.reduce((a, b) => (a.applicationNumberConfidence > b.applicationNumberConfidence) ? a : b);
            else
                applicationWithBestNumber = group.reduce((a, b) => (a.applicationNumberConfidence > b.applicationNumberConfidence) ? a : b);
        }

        // Use the application with the highest confidence address, however override its
        // application number with the application number from the application with the highest
        // confidence application number (where the presence of slashes gives higher confidence).

        applicationWithBestAddress.applicationNumber = applicationWithBestNumber.applicationNumber;
        applicationWithBestAddress.applicationNumberConfidence = applicationWithBestNumber.applicationNumberConfidence;
        chosenApplications.push(applicationWithBestAddress);
    }

    // Group the applications by application number so that if there are multiple applications
    // for the same application number the one with the highest confidence address can be selected.
    
    groupedApplications = {};
    for (let developmentApplication of chosenApplications) {
        let group = groupedApplications[developmentApplication.applicationNumber];
        if (group === undefined)
            groupedApplications[developmentApplication.applicationNumber] = (group = []);
        group.push(developmentApplication);
    }

    chosenApplications = [];
    for (let applicationNumber in groupedApplications)
        chosenApplications.push(groupedApplications[applicationNumber].reduce((a, b) => (a.addressConfidence > b.addressConfidence) ? a : b));

console.log(chosenApplications);

    return chosenApplications;
}

// Formats addresses, correcting any minor spelling errors.  An address is expected to be in the
// following format:
//
//     <StreetNumber> <StreetName> <SuburbName> <StateAbbreviation> <PostCode>
//
// where,
//
//     <StreetNumber> may contain digits, dashes, slashes (and sometimes spaces)
//     <StreetName> is in mixed case and may contain spaces
//     <SuburbName> is usually all uppercase (occasionally mixed case) and may contain spaces
//     <StateAbbreviation> is in all uppercase and may not contain spaces
//     <PostCode> is four digits and may not contain spaces
//
// for example,
//
//     2/121-130A Main North Road MEDINDIE GARDENS SA 5083

function formatAddress(address) {
    let tokens = address.trim().split(/\s+/);
    let formattedAddress = { address: address, hasStreet: false, hasRecognizedStreet: false, hasRecognizedSuburb: false };
        
    // Extract the suburb name (with the state abbreviation "SA" and postcode "5081", "5082" or
    // "5083") while allowing several spaces.  For example, "MEDI NDIE GARDE NS SA 5081" and
    // "FIT ZROY SA 5082".  This attempts to correct the suburb name (but only allows a small
    // amount of change because other a valid street or suburb name such as "Churcher" could be
    // accidentally converted to another equally valid street or suburub name such as "Church").

    let suburbName = null;
    let suburbNameMatch = null;
    for (let index = 0; index < 5 && suburbNameMatch === null; index++) {
        suburbName = (tokens.pop() || "") + ((index === 0) ? "" : (" " + suburbName));
        suburbNameMatch = didyoumean(suburbName, AllSuburbNames, { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
    }

    if (suburbNameMatch === null || tokens.length === 0)
        return formattedAddress;  // give up after several spaces (and assume the address is invalid)

    formattedAddress.hasRecognizedSuburb = true;
    
    // Extract the street name, similarly allowing several spaces, and similarly attempting to
    // correct the street name (allowing only a small amount of change).

    formattedAddress.hasStreet = (tokens.length > 0);
    let removedTokens = [];

    let streetName = null;
    let streetNameMatch = null;
    while (tokens.length > 0) {
        let token = tokens[0];
        if (!/^[0-9]+$/.test(token) && !/^[0-9][A-Za-z]$/.test(token) && token.length >= 2) {  // ignore street numbers, otherwise "6 King Street" is changed to "King Street"; ignore a single character such as "S" (because it is probably, really the digit "5")
            streetName = tokens.join(" ");
            streetNameMatch = didyoumean(streetName, AllStreetNames, { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 3, trimSpace: true });
            if (streetNameMatch !== null)
                break;
        }
        tokens.shift();
        removedTokens.push(token);
    }

    if (streetNameMatch === null) {
        if (suburbNameMatch !== suburbName)
            formattedAddress.address = (removedTokens.join(" ") + " " + suburbNameMatch).trim();  // attempt to preserve the corrected suburb name
        return formattedAddress;  // give up after several spaces
    }

    formattedAddress.hasRecognizedStreet = true;

    // Reconstruct the corrected address.

    if (streetNameMatch !== streetName || suburbNameMatch !== suburbName)
        formattedAddress.address = (removedTokens.join(" ") + " " + streetNameMatch).trim() + " " + suburbNameMatch;
    
    return formattedAddress;
}

// Determine the starting X co-ordering of each column.

function findColumns(lines, scaleFactor) {
    // Start with a large column gap.  Continue to reduce this until exactly five columns are
    // found.  This then caters for some documents where the column gap is very narrow.

    for (let columnGap = ColumnGap; columnGap >= 1; columnGap--) {
        // Determine where the received date, application number, reason, applicant and address are
        // located on each line.  This is partly determined by looking for the sizable gaps between
        // columns.

        let columns = [];
        for (let line of lines) {
            let previousWord = null;
            for (let word of line) {
                if (previousWord === null || word.bounds.x - (previousWord.bounds.x + previousWord.bounds.width) >= columnGap * scaleFactor) {
                    // Found the potential start of another column (count how many times this occurs
                    // at the current X co-ordinate; the more times the more likely it is that this
                    // is actually the start of a column).

                    let closestColumn = columns.find(column => Math.abs(word.bounds.x - column.x) < ColumnAlignment * scaleFactor);
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
        let averageCount = totalCount / 5;  // assume there are five "major" columns
        columns = columns.filter(column => column.count > averageCount / 2);  // low counts indicate low likelihood of the start of a column (arbitrarily use the average count divided by two as a threshold)
        columns.sort((column1, column2) => (column1.x > column2.x) ? 1 : ((column1.x < column2.x) ? -1 : 0));

        // Check if five columns have been found.

console.log(`columnGap=${columnGap} columns.length=${columns.length}.`);
        if (columns.length === 5)
            return columns;
    }

    return null;
}

// Parses the lines of words.  Each word in a line consists of a bounding box, the text that
// exists in that bounding box and the confidence information determined by tesseract.js.  The
// logic here also performs partitioning of the text into columns (for example, the reason and
// address columns).

function parseLines(pdfUrl, lines, scaleFactor) {
    // Determine where the received date, application number, reason, applicant and address
    // start on each line.

console.log(JSON.stringify(lines));

    let columns = findColumns(lines, scaleFactor);
    if (columns === null) {
        console.log("No application numbers were parsed from the current image in the document because could not find five columns.");
        return [];
    }

console.log(columns);

    // Assume that there are five columns: received date, application number, reason, applicant
    // and address.

    let developmentApplications = [];
    for (let line of lines) {
        let receivedDate = "";
        let receivedDateConfidences = [];
        let receivedDateY = null;
        let applicationNumber = "";
        let applicationNumberConfidences = [];
        let applicationNumberY = null;
        let reason = "";
        let reasonConfidences = [];
        let reasonY = null;
        let applicant = "";  // this is currently not used (but extracted for completeness)
        let applicantConfidences = [];
        let applicantY = null;
        let address = "";
        let addressConfidences = [];
        let addressY = null;

        let previousWord = null;
        let columnIndex = 0;

        // Group the words from the line into the five columns.

        for (let index = 0; index < line.length; index++) {
            let word = line[index];

            // Determine if this word lines up with the start of a column, which indicates that
            // the next column has been encountered (keeping in mind that there are five columns:
            // received date, application number, reason, applicant and address).

            let findColumnIndex = columns.findIndex(column => Math.abs(column.x - word.bounds.x) < ColumnAlignment * scaleFactor);
            if (previousWord !== null && findColumnIndex >= 0) {
                columnIndex = findColumnIndex;
                if (columnIndex === 0)
                    receivedDateY = word.bounds.y;
                else if (columnIndex === 1)
                    applicationNumberY = word.bounds.y;
                else if (columnIndex === 2)
                    reasonY = word.bounds.y;
                else if (columnIndex === 3)
                    applicantY = word.bounds.y;
                else if (columnIndex === 4)
                    addressY = word.bounds.y;
            }

            // Add the word to the currently determined column.

            if (columnIndex === 0) {
                receivedDate += word.text;
                receivedDateConfidences.push(word.confidence);
            } else if (columnIndex === 1) {
                applicationNumber += word.text;
                applicationNumberConfidences.push(word.confidence);
            } else if (columnIndex === 2) {
                reason += ((reason === "") ? "" : " ") + word.text;
                reasonConfidences.push(word.confidence);
            } else if (columnIndex === 3) {
                applicant += ((applicant === "") ? "" : " ") + word.text;
                applicantConfidences.push(word.confidence);
            } else if (columnIndex === 4) {
                address += ((address === "") ? "" : " ") + word.text;
                addressConfidences.push(word.confidence);
            }

            previousWord = word;
        }

        // Re-format the address (making minor corrections where possible).

        let formattedAddress = formatAddress(address);
        // if (formattedAddress.address !== address)
        //     console.log(`    Corrected "${address}" to "${formattedAddress.address}".`);

        // Parse the received date so that it can be reformatted.

        let parsedReceivedDate = moment(receivedDate.trim(), "D/MM/YYYY", true);
        if (!parsedReceivedDate.isValid())
            parsedReceivedDate = moment(receivedDate.trim(), "YYYY-MM-DDTHH:mm:ss", true);

        // Derive a confidence percentage for most columns.  Note that the address is the most
        // important column.  The other information matters a lot less (the main concern is to
        // identify an address for which a development application has been lodged).

        let addressConfidence = addressConfidences.reduce((a, b) => a + b, 0) / Math.max(1, addressConfidences.length);
        let applicationNumberConfidence = applicationNumberConfidences.reduce((a, b) => a + b, 0) / Math.max(1, applicationNumberConfidences.length);
        let reasonConfidence = reasonConfidences.reduce((a, b) => a + b, 0) / Math.max(1, reasonConfidences.length);

let receivedDateConfidence = receivedDateConfidences.reduce((a, b) => a + b, 0) / Math.max(1, receivedDateConfidences.length);
let applicantConfidence = applicantConfidences.reduce((a, b) => a + b, 0) / Math.max(1, applicantConfidences.length);
if (formattedAddress.hasStreet && formattedAddress.hasRecognizedSuburb)
    console.log(`${receivedDate.trim()}[${Math.round(receivedDateConfidence)}% ${receivedDateY}] ${applicationNumber.trim()}[${Math.round(applicationNumberConfidence)}% ${applicationNumberY}] ${reason.trim()}[${Math.round(reasonConfidence)}% ${reasonY}] ${applicant.trim()}[${Math.round(applicantConfidence)}% ${applicantY}] ${formattedAddress.address.trim()}[${Math.round(addressConfidence)}% ${addressY}]`);

        developmentApplications.push({
            applicationNumber: applicationNumber.trim(),
            address: formattedAddress.address.trim(),
            reason: reason.trim(),
            informationUrl: pdfUrl,
            commentUrl: CommentUrl,
            scrapeDate: moment().format("YYYY-MM-DD"),
            receivedDate: parsedReceivedDate.isValid() ? parsedReceivedDate.format("YYYY-MM-DD") : "",
            hasStreet: formattedAddress.hasStreet,
            hasRecognizedStreet: formattedAddress.hasRecognizedStreet,
            hasRecognizedSuburb: formattedAddress.hasRecognizedSuburb,
            addressConfidence: addressConfidence,
            applicationNumberConfidence: applicationNumberConfidence,
            reasonConfidence: reasonConfidence });
    }

    // Where the same development application number appears multiple times, choose the development
    // application with the highest confidence value.  Application numbers often appear multiple
    // times because the image is examined step by step in overlapping "sections".

    return chooseDevelopmentApplications(developmentApplications);
}

// Parses an image (from a PDF file).

async function parseImage(pdfUrl, image, scaleFactor) {
    // The image is examined in overlapping sections to reduce the memory usage (there is currently
    // a hard limit of 512 MB when running in morph.io).

    let lines = [];

// return parseLines(pdfUrl, lines, scaleFactor);

    console.log(`    Image x is [0..${image.width - 1}], y is [0..${image.height - 1}].`);
    for (let sectionY = 0; sectionY < image.height; sectionY += SectionStep) {
        let sectionHeight = Math.min(image.height - sectionY, SectionHeight);
        // console.log(`    Examining y in [${sectionY}..${sectionY + sectionHeight - 1}] of [0..${image.height - 1}].`)

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

        jimpImage.crop(0, sectionY, image.width, sectionHeight).scale(scaleFactor, jimp.RESIZE_BEZIER);
        let imageBuffer = await (new Promise((resolve, reject) => jimpImage.getBuffer(jimp.MIME_PNG, (error, buffer) => resolve(buffer))));

        // Perform OCR on the image (this is extremely memory and CPU intensive).

        let result = await new Promise((resolve, reject) => { tesseract.recognize(imageBuffer).then(function(result) { resolve(result); }) });

        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the current
        // process being terminated by morph.io).

        tesseract.terminate();
        if (global.gc)
            global.gc();

        // Simplify the lines.

        if (result.blocks && result.blocks.length)
            for (let block of result.blocks)
                for (let paragraph of block.paragraphs)
                    for (let line of paragraph.lines)
                        lines.push(line.words.map(word => { return { text: word.text, confidence: word.confidence, choices: word.choices.length, bounds: { x: word.bbox.x0, y: sectionY + word.bbox.y0, width: word.bbox.x1 - word.bbox.x0, height: word.bbox.y1 - word.bbox.y0 } }; }));
    }

    // Analyse the lines of words to extract development application details.  Each word in a line
    // includes a confidence percentage and a bounding box.

    return parseLines(pdfUrl, lines, scaleFactor);
}

// Parses a single PDF file.

async function parsePdf(database, pdfUrl, pdf, scaleFactor) {
    let imageCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        console.log(`Examining page ${pageNumber} of ${pdf.numPages} in the PDF.`);

        let page = await pdf.getPage(pageNumber);
        let operators = await page.getOperatorList();

        // Find and parse any images in the PDF.

        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] === pdfjs.OPS.paintImageXObject) {
                let operator = operators.argsArray[index][0];
                let image = page.objs.get(operator);
                imageCount++;
                console.log(`Examining image ${imageCount} in the PDF.`);
                let developmentApplications = await parseImage(pdfUrl, image, scaleFactor);

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
    if (pdfUrls.length === 1)
        twoPdfUrls = [ pdfUrls[0] ];
    else if (pdfUrls.length >= 2) {
        if (moment().second() % 2 === 0)
            twoPdfUrls = [ pdfUrls[0], pdfUrls[getRandom(1, pdfUrls.length)] ];
        else
            twoPdfUrls = [ pdfUrls[getRandom(1, pdfUrls.length)], pdfUrls[0] ];
    }

// pdfUrls.shift();
// pdfUrls.splice(0, 15);
console.log(`Selecting ${pdfUrls.length} document(s).`);
twoPdfUrls = pdfUrls;
twoPdfUrls = [ "http://www.prospect.sa.gov.au/webdata/resources/files/New%20DAs%2018%20June%202018%20to%201%20July%202018.pdf" ];

// If odd day then scale factor 5.0; if even day then scale factor 6.0
let scaleFactor = 5.0;

    console.log("Selected the following documents to parse:");
    for (let pdfUrl of twoPdfUrls)
        console.log(`    ${pdfUrl}`);
    
    for (let pdfUrl of twoPdfUrls) {
        // Read the PDF containing an image of several development applications.  Note that setting
        // disableFontFace to true avoids a "document is not defined" exception that is otherwise
        // thrown in fontLoaderInsertRule.

        console.log(`Retrieving document: ${pdfUrl}`);
        let pdf = await pdfjs.getDocument({ url: pdfUrl, disableFontFace: true });
        await parsePdf(database, pdfUrl, pdf, scaleFactor);  // this inserts development applications into the database
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
