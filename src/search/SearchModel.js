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

/*global define, $ */

define(function (require, exports, module) {
    "use strict";
    
    var _         = require("thirdparty/lodash"),
        FileUtils = require("file/FileUtils");
    
    /**
     * @constructor
     * Manages a set of search query and result data.
     * Dispatches these events:
     *      "change" - whenever the results have been updated. Note that it's up to people who
     *      edit the model to call fireChange() when necessary - it doesn't automatically fire.
     *      "clear" - when the model is cleared to an empty state.
     */
    function SearchModel() {
        this.clear();
    }

    /** 
     * The current set of results.
     * @type {Object.<fullPath: string, {matches: Array.<Object>, collapsed: boolean, timestamp: Date}>}
     */
    SearchModel.prototype.results = null;

    /**
     * The query that generated these results.
     * @type {{query: string, caseSensitive: boolean, isRegexp: boolean}}
     */
    SearchModel.prototype.queryInfo = null;

    /**
     * Whether this is a find/replace query.
     * @type {boolean}
     */
    SearchModel.prototype.isReplace = false;

    /**
     * The replacement text specified for this query, if any.
     * @type {string}
     */
    SearchModel.prototype.replaceText = null;

    /**
     * The file/folder path representing the scope that this query was performed in.
     * @type {string}
     */
    SearchModel.prototype.scope = null;

    /**
     * Whether or not we hit the maximum number of results for the type of search we did.
     * @type {boolean}
     */
    SearchModel.prototype.foundMaximum = false;

    /**
     * Clears out the model to an empty state.
     */
    SearchModel.prototype.clear = function () {
        this.results = {};
        this.queryInfo = null;
        this.isReplace = false;
        this.replaceText = null;
        this.scope = null;
        this.foundMaximum = false;
        $(this).triggerHandler("clear");
    };

    /**
     * Adds the given result matches to the search results
     * @param {string} fullpath
     * @param {Array.<Object>} matches
     */
    SearchModel.prototype.addResultMatches = function (fullpath, matches, timestamp) {
        this.results[fullpath] = {
            matches:   matches,
            collapsed: false,
            timestamp: timestamp
        };
    };

    /**
     * @return true if there are any results in this model.
     */
    SearchModel.prototype.hasResults = function () {
        return Object.keys(this.results).length > 0;
    };

    /**
     * Counts the total number of matches and files
     * @return {{files: number, matches: number}}
     */
    SearchModel.prototype.countFilesMatches = function () {
        var numFiles = 0, numMatches = 0;
        _.forEach(this.results, function (item) {
            numFiles++;
            numMatches += item.matches.length;
        });

        return {files: numFiles, matches: numMatches};
    };

    /**
     * Sorts the file keys to show the results from the selected file first and the rest sorted by path
     * @return {Array.<string>}
     */
    SearchModel.prototype.getSortedFiles = function () {
        var searchFiles = Object.keys(this.results),
            self        = this;

        searchFiles.sort(function (key1, key2) {
            if (self._selectedEntry === key1) {
                return -1;
            } else if (self._selectedEntry === key2) {
                return 1;
            }
            return FileUtils.comparePaths(key1, key2);
        });

        return searchFiles;
    };

    /**
     * Notifies listeners that the set of results has changed. Must be called after the
     * model is changed.
     * @param {boolean} quickChange Whether this type of change is one that might occur
     *      often, meaning that the view should buffer updates.
     */
    SearchModel.prototype.fireChanged = function (quickChange) {
        $(this).triggerHandler("change", quickChange);
    };

    // Public API
    exports.SearchModel = SearchModel;
});
