/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, $ */

define(function (require, exports, module) {
    "use strict";
    
    var Async           = require("utils/Async"),
        DocumentManager = require("document/DocumentManager"),
        FileSystem      = require("filesystem/FileSystem"),
        FileUtils       = require("file/FileUtils"),
        ProjectManager  = require("project/ProjectManager"),
        Strings         = require("strings"),
        StringUtils     = require("utils/StringUtils"),
        CodeMirror      = require("thirdparty/CodeMirror2/lib/codemirror"),
        _               = require("thirdparty/lodash");
    
    /**
     * Given a replace string that contains $-expressions, replace them with data from the given
     * regexp match info.
     * NOTE: we can't just use the ordinary replace() function here because the string has been
     * extracted from the original text and so might be missing some context that the regexp matched.
     * @param {string} replaceWith The string containing the $-expressions.
     * @param {Object} match The match data from the regexp.
     * @return {string} The replace text with the $-expressions substituted.
     */
    function parseDollars(replaceWith, match) {
        replaceWith = replaceWith.replace(/(\$+)(\d{1,2}|&)/g, function (whole, dollars, index) {
            var parsedIndex = parseInt(index, 10);
            if (dollars.length % 2 === 1) { // check if dollar signs escape themselves (for example $$1, $$$$&)
                if (index === "&") { // handle $&
                    return dollars.substr(1) + (match[0] || "");
                } else if (parsedIndex !== 0) { // handle $n or $nn, don't handle $0 or $00
                    return dollars.substr(1) + (match[parsedIndex] || "");
                }
            }
            return whole;
        });
        replaceWith = replaceWith.replace(/\$\$/g, "$"); // replace escaped dollar signs (for example $$) with single ones
        return replaceWith;
    }
    
        /**
     * Does a set of replacements in a single document in memory.
     * @param {!Document} doc The document to do the replacements in.
     * @param {Object} matchInfo The match info for this file, as returned by `_addSearchMatches()`. Might be mutated.
     * @param {string} replaceText The text to replace each result with.
     * @param {boolean=} isRegexp Whether the original query was a regexp.
     * @return {$.Promise} A promise that's resolved when the replacement is finished or rejected with an error if there were one or more errors.
     */
    function _doReplaceInDocument(doc, matchInfo, replaceText, isRegexp) {
        // TODO: if doc has changed since query was run, don't do replacement
        
        // Do the replacements in reverse document order so the offsets continue to be correct.
        matchInfo.matches.sort(function (match1, match2) {
            return CodeMirror.cmpPos(match2.start, match1.start);
        });
        doc.batchOperation(function () {
            matchInfo.matches.forEach(function (match) {
                if (match.isChecked) {
                    doc.replaceRange(isRegexp ? parseDollars(replaceText, match.result) : replaceText, match.start, match.end);
                }
            });
        });
        
        return new $.Deferred().resolve().promise();
    }
    
    /**
     * Does a set of replacements in a single file on disk.
     * @param {string} fullPath The full path to the file.
     * @param {Object} matchInfo The match info for this file, as returned by `_addSearchMatches()`.
     * @param {string} replaceText The text to replace each result with.
     * @param {boolean=} isRegexp Whether the original query was a regexp.
     * @return {$.Promise} A promise that's resolved when the replacement is finished or rejected with an error if there were one or more errors.
     */
    function _doReplaceOnDisk(fullPath, matchInfo, replaceText, isRegexp) {
        var file = FileSystem.getFileForPath(fullPath);
        return DocumentManager.getDocumentText(file, true).then(function (contents, timestamp, lineEndings) {
            if (timestamp.getTime() !== matchInfo.timestamp.getTime()) {
                // Return a promise that we'll reject immediately. (We can't just return the
                // error since this is the success handler.)
                return new $.Deferred().reject(exports.ERROR_FILE_CHANGED).promise();
            }

            // Note that this assumes that the matches are sorted.
            // TODO: is there a more efficient way to do this in a large string?
            var result = [],
                lastIndex = 0;
            matchInfo.matches.forEach(function (match) {
                if (match.isChecked) {
                    result.push(contents.slice(lastIndex, match.startOffset));
                    result.push(isRegexp ? parseDollars(replaceText, match.result) : replaceText);
                    lastIndex = match.endOffset;
                }
            });
            result.push(contents.slice(lastIndex));

            var newContents = result.join("");
            // TODO: duplicated logic from Document - should refactor this?
            if (lineEndings === FileUtils.LINE_ENDINGS_CRLF) {
                newContents = newContents.replace(/\n/g, "\r\n");
            }

            return Async.promisify(file, "write", newContents);
        });
    }
    
    /**
     * Does a set of replacements in a single file. If the file is already open in a Document in memory,
     * will do the replacement there, otherwise does it directly on disk.
     * @param {string} fullPath The full path to the file.
     * @param {Object} matchInfo The match info for this file, as returned by `_addSearchMatches()`.
     * @param {string} replaceText The text to replace each result with.
     * @param {Object=} options An options object:
     *      forceFilesOpen: boolean - Whether to open the file in an editor and do replacements there rather than doing the 
     *          replacements on disk. Note that even if this is false, files that are already open in editors will have replacements
     *          done in memory.
     *      isRegexp: boolean - Whether the original query was a regexp. If true, $-substitution is performed on the replaceText.
     * @return {$.Promise} A promise that's resolved when the replacement is finished or rejected with an error if there were one or more errors.
     */
    function _doReplaceInOneFile(fullPath, matchInfo, replaceText, options) {
        var doc = DocumentManager.getOpenDocumentForPath(fullPath);
        options = options || {};
        if (options.forceFilesOpen && !doc) {
            return DocumentManager.getDocumentForPath(fullPath).then(function (newDoc) {
                return _doReplaceInDocument(newDoc, matchInfo, replaceText, options.isRegexp);
            });
        } else if (doc) {
            return _doReplaceInDocument(doc, matchInfo, replaceText, options.isRegexp);
        } else {
            return _doReplaceOnDisk(fullPath, matchInfo, replaceText, options.isRegexp);
        }
    }
    
    /**
     * @private
     * Returns true if a search result has any checked matches.
     */
    function hasCheckedMatches(result) {
        return result.matches.some(function (match) { return match.isChecked; });
    }
        
    /**
     * Given a set of search results, replaces them with the given replaceText, either on disk or in memory.
     * @param {Object.<fullPath: string, {matches: Array.<{start: {line:number,ch:number}, end: {line:number,ch:number}, startOffset: number, endOffset: number, line: string}>, collapsed: boolean}>} results
     *      The list of results to replace, as returned from _doSearch..
     * @param {string} replaceText The text to replace each result with.
     * @param {?Object} options An options object:
     *      forceFilesOpen: boolean - Whether to open all files in editors and do replacements there rather than doing the 
     *          replacements on disk. Note that even if this is false, files that are already open in editors will have replacements
     *          done in memory.
     *      isRegexp: boolean - Whether the original query was a regexp. If true, $-substitution is performed on the replaceText.
     * @return {$.Promise} A promise that's resolved when the replacement is finished or rejected with an array of errors
     *      if there were one or more errors. Each individual item in the array will be a {item: string, error: string} object,
     *      where item is the full path to the file that could not be updated, and error is either a FileSystem error or one 
     *      of the `FindUtils.ERROR_*` constants.
     */
    function performReplacements(results, replaceText, options) {
        return Async.doInParallel_aggregateErrors(Object.keys(results), function (fullPath) {
            return _doReplaceInOneFile(fullPath, results[fullPath], replaceText, options);
        }).done(function () {
            if (options && options.forceFilesOpen) {
                // If the currently selected document wasn't modified by the search, or there is no open document,
                // then open the first modified document.
                var doc = DocumentManager.getCurrentDocument();
                if (!doc ||
                        !results[doc.file.fullPath] ||
                        !hasCheckedMatches(results[doc.file.fullPath])) {
                    // Figure out the first modified document. This logic is slightly different from
                    // SearchResultsView._getSortedFiles() because it doesn't sort the currently open file to
                    // the top. But if the currently open file were in the search results, we wouldn't be
                    // doing this anyway.
                    var sortedPaths = Object.keys(results).sort(FileUtils.comparePaths),
                        firstPath = _.find(sortedPaths, function (path) {
                            return hasCheckedMatches(results[path]);
                        });
                    
                    if (firstPath) {
                        var newDoc = DocumentManager.getOpenDocumentForPath(firstPath);
                        if (newDoc) {
                            DocumentManager.setCurrentDocument(newDoc);
                        }
                    }
                }
            }
        });
    }
    
    /**
     * Returns label text to indicate the search scope. Already HTML-escaped.
     * @param {?Entry} scope
     * @return {string}
     */
    function labelForScope(scope) {
        if (scope) {
            return StringUtils.format(
                Strings.FIND_IN_FILES_SCOPED,
                StringUtils.breakableUrl(
                    ProjectManager.makeProjectRelativeIfPossible(scope.fullPath)
                )
            );
        } else {
            return Strings.FIND_IN_FILES_NO_SCOPE;
        }
    }

    exports.parseDollars        = parseDollars;
    exports.hasCheckedMatches   = hasCheckedMatches;
    exports.performReplacements = performReplacements;
    exports.labelForScope       = labelForScope;
    exports.ERROR_FILE_CHANGED  = "fileChanged";
});
