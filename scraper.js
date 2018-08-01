// Parses the development applications at the South Australian City of Prospect web site and
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
const LineAlignment = 5;  // text within this number of pixels vertically is considered to be on the same line

// All street and suburb names (used when correcting addresses).

let AllStreetNames = null;
let AllSuburbNames = null;

// Spelling corrections for the reason text.

let SpellingCorrections = null;

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

// Corrects common spelling errors in the reason text.

function formatReason(reason) {
    // Replace a common misspelling.

    reason = reason.replace(/ﬁ/g, "fi");

    // Split the text whenever a sequence of letters is encountered.  And then correct any common
    // misspellings of words (for example, correct "Existinq" to "Existing").

    let formattedReason = "";
    let isPreviousLetter = null;
    let previousIndex = null;

    for (let index = 0; index <= reason.length; index++) {
        let c = (index === reason.length) ? 0 : reason.charCodeAt(index);
        let isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);  // A-Z or a-z
        if (isLetter !== isPreviousLetter || c === 0) {
            if (previousIndex !== null) {
                let spellingCorrection = SpellingCorrections[reason.substring(previousIndex, index)];
                formattedReason += (spellingCorrection === undefined) ? reason.substring(previousIndex, index) : spellingCorrection;
            }
            previousIndex = index;
            isPreviousLetter = isLetter;
        }
    }

    return formattedReason;
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
    let formattedAddress = { text: address.trim(), hasStreet: false, hasRecognizedStreet: false, hasRecognizedSuburb: false };
        
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
            formattedAddress.text = (removedTokens.join(" ") + " " + suburbNameMatch).trim();  // attempt to preserve the corrected suburb name
        return formattedAddress;  // give up after several spaces
    }

    formattedAddress.hasRecognizedStreet = true;

    // Reconstruct the corrected address.

    if (streetNameMatch !== streetName || suburbNameMatch !== suburbName)
        formattedAddress.text = (removedTokens.join(" ") + " " + streetNameMatch).trim() + " " + suburbNameMatch;
    
    return formattedAddress;
}

// Determine the starting X co-ordering of each column.

function findColumns(lines, scaleFactor) {
    // Start with a large column gap.  Continue to reduce this until exactly five columns are
    // found.  This then caters for some documents where the column gap is very narrow.

    for (let columnGap = ColumnGap; columnGap >= 1; columnGap--) {
        // Determine where the received date, application number, reason, applicant and address
        // are located on each line.  This is partly determined by looking for the sizable gaps
        // between columns.

        let columns = [];
        for (let line of lines) {
            let previousWord = null;
            for (let word of line) {
                if (previousWord === null || word.bounds.x - (previousWord.bounds.x + previousWord.bounds.width) >= columnGap * scaleFactor) {
                    // Found the potential start of another column (count how many times this
                    // occurs at the current X co-ordinate; the more times the more likely it
                    // is that this is actually the start of a column).

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

        if (columns.length === 5)
            return columns;
    }

    return null;
}

// Merge an array of rows into a single row by choosing the cells in each column that have the
// highest confidence.  Although for the received date and application number columns prefer
// those with two slashes over those with other numbers of slashes (even if the application
// number has lower confidence).

function mergeRows(rows) {
    let mergedRow = rows[0];
    for (let columnIndex = 0; columnIndex < mergedRow.length; columnIndex++) {
        if (columnIndex == 0 || columnIndex == 1) {  // received date or application number
            // The received date and application number are better if they contain two slashes.
            // For example, "29/01/2017" and "060/331/2018".  The closer to two slashes the better
            // (hence the use of the word "distance" in variable names below).

            let mergedCellSlashDistance = Math.abs(2 - (mergedRow[columnIndex].text.split("/").length - 1));
            for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
                let cellSlashDistance = Math.abs(2 - (rows[rowIndex][columnIndex].text.split("/").length - 1));
                if (cellSlashDistance <= mergedCellSlashDistance && rows[rowIndex][columnIndex].confidence > mergedRow[columnIndex].confidence) {
                    mergedRow[columnIndex].text = rows[rowIndex][columnIndex].text;
                    mergedRow[columnIndex].confidence = rows[rowIndex][columnIndex].confidence;
                }
            }
        } else {
            // For other columns such as reason and address simply look at the confidence values.

            for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
                if (rows[rowIndex][columnIndex].confidence > mergedRow[columnIndex].confidence) {
                    mergedRow[columnIndex].text = rows[rowIndex][columnIndex].text;
                    mergedRow[columnIndex].confidence = rows[rowIndex][columnIndex].confidence;
                }
            }
        }
    }
    return mergedRow;
}

// Parses the lines of words.  Each word in a line consists of a bounding box, the text that
// exists in that bounding box and the confidence information determined by tesseract.js.  The
// logic here also performs partitioning of the text into columns (for example, the reason and
// address columns).

function parseLines(pdfUrl, lines, scaleFactor) {
    // Determine where the received date, application number, reason, applicant and address
    // start on each line.

    let columns = findColumns(lines, scaleFactor);
    if (columns === null) {
        console.log("No application numbers were parsed from the current image in the document because five columns were not found.");
        return [];
    }

    // Assume that there are five columns: received date, application number, reason, applicant
    // and address.

    let rows = [];
    for (let line of lines) {
        // Initialise the row object which will contain the results of parsing the line.

        let row = columns.map(() => { return { y: null, texts: [], text: "", confidences: [], confidence: 0 }; });

        // Group the words from the line into the five columns.

        let cell = null;
        for (let word of line) {
            // Determine if this word lines up with the start of a column (keeping in mind that
            // there are five columns: received date, application number, reason, applicant and
            // address).

            let columnIndex = columns.findIndex(column => Math.abs(column.x - word.bounds.x) < ColumnAlignment * scaleFactor);
            if (columnIndex >= 0) {
                cell = row[columnIndex];
                cell.y = word.bounds.y;
            }

            // Add the word to the currently determined column.

            if (cell !== null) {
                cell.texts.push(word.text);
                cell.confidences.push(word.confidence);
            }
        }

        // Aggregate the data gathered for each column.

        for (let cell of row)
            cell.confidence = cell.confidences.reduce((a, b) => a + b, 0) / Math.max(1, cell.confidences.length);  // average confidence

        // Join together the words into text for each column of the row.

        row[0].text = row[0].texts.join("").trim();  // received date
        row[1].text = row[1].texts.join("").trim();  // application number
        row[2].text = row[2].texts.join(" ").trim();  // applicant (not currently used)
        row[3].text = row[3].texts.join(" ").trim();  // reason
        row[4].text = row[4].texts.join(" ").trim();  // address

        // Ignore any rows where there is any cell with a confidence under 60% (this indicates that
        // some text was extremely unreliable and was maybe horizontally cut in half).  Ignore any
        // rows where there is not at least one slash in the received date or application number.

        if (row.find(cell => cell.confidence < 60) === undefined)  // ensure that all cells are 60% or above in confidence
            if (row[0].text.indexOf("/") >= 0 || row[1].text.indexOf("/") >= 0)  // ensure that the characters are not just random in the received date and application number (due to being cut in half horizontally)
                rows.push(row);
    }

    // Group the rows by Y co-ordinate (the same row typically appears multiple times because the
    // image was examined vertically in overlapping steps).

    let groups = [];
    for (let row of rows) {
        let group = groups.find(group => Math.abs(group.y - row[0].y) < LineAlignment * scaleFactor);
        if (group === undefined) {
            group = { y: row[0].y, rows: [] };
            groups.push(group);
        }
        group.rows.push(row);
    }

    // Within each column (within a group) choose the cell with the highest confidence.

    rows = [];
    for (let group of groups)
        rows.push(mergeRows(group.rows));

    // Group together rows with the same application number.

    groups = [];
    for (let row of rows) {
        let group = groups.find(group => group.applicationNumber === row[1].text);
        if (group === undefined) {
            group = { applicationNumber: row[1].text, rows: [] };
            groups.push(group);
        }
        group.rows.push(row);
    }

    // Within each column (within a group) choose the cell with the highest confidence.

    rows = [];
    for (let group of groups)
        rows.push(mergeRows(group.rows));

    // Convert all of the rows to development applications.

    let developmentApplications = [];
    for (let row of rows) {
        // Re-format the address (making minor corrections where possible).
        
        let formattedAddress = formatAddress(row[4].text);

        // Parse the received date so that it can be reformatted.

        let receivedDate = moment(row[0].text, "D/MM/YYYY", true);
        if (!receivedDate.isValid())
            receivedDate = moment(row[0].text, "YYYY-MM-DDTHH:mm:ss", true);

        // Ensure that the formatted address has a street name (possibly not recognised) and has
        // a recognised suburb name.  Ensure that the development application number is not blank
        // and has a reasonably high confidence (at least 70%).  Ensure that the address text has
        // reasonably high confidence (at least 75%).  And ensure that a Y co-ordinate has been
        // determined.

        if (formattedAddress.hasStreet && formattedAddress.hasRecognizedSuburb && row[1].text !== "" && row[1].confidence >= 70 && row[4].confidence >= 75 && row[0].y !== null) {
            developmentApplications.push({
                applicationNumber: row[1].text,
                address: formattedAddress.text,
                reason: formatReason(row[2].text),
                informationUrl: pdfUrl,
                commentUrl: CommentUrl,
                scrapeDate: moment().format("YYYY-MM-DD"),
                receivedDate: receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : ""
            });
        }
    }

    return developmentApplications;
}

// Parses an image (from a PDF file).

async function parseImage(pdfUrl, image, scaleFactor) {
    // The image is examined in overlapping sections to reduce the memory usage (there is currently
    // a hard limit of 512 MB when running in morph.io).

    let lines = [];

    for (let sectionY = 0; sectionY < image.height; sectionY += SectionStep) {
        let sectionHeight = Math.min(image.height - sectionY, SectionHeight);

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

        // Simplify the lines (remove most of the information generated by tesseract.js).

        if (result.blocks && result.blocks.length)
            for (let block of result.blocks)
                for (let paragraph of block.paragraphs)
                    for (let line of paragraph.lines)
                        lines.push(line.words.map(word => { return { text: word.text, confidence: word.confidence, choices: word.choices.length, bounds: { x: word.bbox.x0, y: sectionY * scaleFactor + word.bbox.y0, width: word.bbox.x1 - word.bbox.x0, height: word.bbox.y1 - word.bbox.y0 } }; }));
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
                console.log(`Examining image ${imageCount} having dimensions ${image.width} by ${image.height}.`);
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

    // Read the file containing spelling corrections for the reason text.

    SpellingCorrections = {};
    for (let correction of fs.readFileSync("words.txt").toString().replace(/\r/g, "").trim().split("\n"))
        SpellingCorrections[correction.split(",")[0]] = correction.split(",")[1];
        
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

console.log(`Selecting ${pdfUrls.length} document(s).`);
twoPdfUrls = pdfUrls;

// If an odd day then scale factor 5.0 otherwise if an even day then scale factor 6.0.

let scaleFactor = 5.0;
console.log(`Scale factor ${scaleFactor}.`);

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
