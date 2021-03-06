var pathToData = './../data/';
var pathToDataTables = pathToData + 'out/tables/';

try {
    var querystring = require('querystring');
    var https = require('https');
    var fs = require('fs');
    const path = require('path');
    var conversions = require('./conversions.json');
    var config = require(pathToData + 'config.json');
    var util = require('util');
    var csvWriter = require('csv-write-stream');
} catch (e) {
    console.log(e);
    process.exit(1);
}

if (typeof config.parameters === 'undefined') {
    console.log('Missing configuration');
    process.exit(1);
}

if (typeof config.parameters.url === 'undefined' || config.parameters.url === '') {
    config.parameters.url = "https://api.rubiconproject.com/analytics/v/report";
}

if (typeof config.parameters.simultaneousRequestsCount === 'undefined') {
    config.parameters.simultaneousRequestsCount = 19;
}

function dateFormat(date, fstr, utc) {
    utc = utc ? 'getUTC' : 'get';
    return fstr.replace(/%[YmdHMS]/g, function (m) {
        switch (m) {
            case '%Y':
                return date[utc + 'FullYear'](); // no leading zeros required
            case '%m':
                m = 1 + date[utc + 'Month']();
                break;
            case '%d':
                m = date[utc + 'Date']();
                break;
            case '%H':
                m = date[utc + 'Hours']();
                break;
            case '%M':
                m = date[utc + 'Minutes']();
                break;
            case '%S':
                m = date[utc + 'Seconds']();
                break;
            default:
                return m.slice(1); // unknown code, remove %
        }
        // add leading zero if required
        return ('0' + m).slice(-2);
    });
}


var from = new Date();
from.setHours(0, 0, 0, 0);
from.setDate(from.getDate() - 1);
var startDate = dateFormat(from, "%Y-%m-%dT%H:00:00-00:00", true);

var to = new Date();
to.setHours(23, 0, 0, 0);
to.setDate(to.getDate() - 1);
var endDate = dateFormat(to, "%Y-%m-%dT%H:59:59-00:00", true);

var outputDate = dateFormat(to, "%Y-%m-%d", true);


var params = config.parameters;
var callParams = {
    'dimensions': getColumnNamesForType((params['columnsToReturn']) ? params['columnsToReturn'] : [], 'Dimension'),
    'metrics': getColumnNamesForType((params['columnsToReturn']) ? params['columnsToReturn'] : [], 'Metric'),
    'filters': params.filters || '',
    'account': params.account || '',
    'start': params.start || startDate,
    'end': params.end || endDate,
    'currency': params.currency || 'USD',
    'limit': params.limit || 100000
};


if (callParams.account === '') {
    console.log('Missing account value.');
    process.exit(1);
}

if (callParams.dimensions.length === 0) {
    console.log('Missing dimension column.');
    process.exit(1);
}

if (callParams.metrics.length === 0) {
    console.log('Missing metric column.');
    process.exit(1);
}

if (!params.onlyDimensionOutput) {
    if (callParams.metrics.length === 0) {
        console.log('Missing metric column.');
        process.exit(1);
    }

    if ((callParams.dimensions.length + callParams.metrics.length) !== params['requestedColumns'].length) {
        console.log('Wrong value in config.params.requestedColumns');
        process.exit(1);
    }
} else {
    callParams.metrics = ['auctions'];
}

var numberOfCalls = 0;
var callBuffer = [];
var urlWithErrors = [];

var csvHeader = getColumnNamesForType(params['requestedColumns'], (params.onlyDimensionOutput) ? 'Dimension' : undefined);
if (params.addDateToOutput) {
    csvHeader.unshift('date');
}
var writer = csvWriter({headers: csvHeader});
writer.pipe(fs.createWriteStream(pathToDataTables + 'output.csv'));

var writerErrors = csvWriter({headers: ['statusCode', 'path', 'error']});
writerErrors.pipe(fs.createWriteStream(pathToDataTables + 'errors.csv'));

function callRubiconDone() {
    numberOfCalls--;
    if (numberOfCalls < config.parameters.simultaneousRequestsCount && callBuffer.length > 0) {
        var nextValues = callBuffer.shift();
        callRubicon(nextValues[0], nextValues[1]);
    }
}

function callRubicon(params, callback) {

    process.stdout.write(".");

    if (numberOfCalls >= config.parameters.simultaneousRequestsCount) {
        callBuffer.push([params, callback]);
        return;
    }

    numberOfCalls++;
    var paramsByKey = [];
    for (var key in params) {
        if (!params.hasOwnProperty(key)) {
            continue;
        }
        var val = params[key];
        if (val !== '') {
            paramsByKey.push(key + '=' + ((util.isArray(val)) ? val.join(',') : val));
        }
    }

    var options = {
        host: 'api.rubiconproject.com',
        port: '443',
        path: '/analytics/v1/report?' + paramsByKey.join('&'),
        method: 'GET',
        headers: {
            'Authorization': 'Basic :' + config.parameters.basicAuth
        }
    };

    var req = https.request(options, function (res) {
        var output = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            output += chunk;
        });
        res.on('end', function () {
            if (res.statusCode >= 200 && res.statusCode < 400) {
                callback({
                    'statusCode': res.statusCode,
                    'path': options.path,
                    'result': (output) ? output : ''
                });
            } else {
                if (urlWithErrors.indexOf(options.path) === -1 || parseInt(res.statusCode) === 429) {
                    callBuffer.push([params, callback]);
                    urlWithErrors.push(options.path);
                } else {

                    handleErrorResponse({
                        'statusCode': res.statusCode,
                        'result': (output) ? output : '',
                        'path': options.path
                    });
                }
            }
            callRubiconDone();
        });
    });

    req.on('error', function (err) {
        handleErrorResponse({
            'statusCode': err.statusCode || 0,
            'error': err.message || '',
            'path': options.path
        });
        callRubiconDone();
    });
    req.end();
}

var rubiconCaller = function () {
    if (config.parameters.dimensionsFilter
        && config.parameters.dimensionsFilter.length > 0) {
        callGranularRubicon(-1, (typeof params.filters !== 'undefined' && params.filters !== '') ? params.filters : '');
    } else {
        callRubicon(callParams, handleResponse);
    }
};

function callGranularRubicon(index, filters) {

    var params = util._extend(config.parameters);
    var newIndex = index + 1;
    var newCallParams = util._extend({}, callParams);

    if ((newIndex + 1) > params['dimensionsFilter'].length) {
        newCallParams['filters'] = filters;
        callRubicon(newCallParams, handleResponse);
    } else {
        var newDimension = [getColumnNamesForType([params['dimensionsFilter'][newIndex]], 'Dimension')[0]];
        var newMetric = [getColumnNamesForType([params['metricFilter'][0]], 'Metric')[0] || 'auctions'];
        newCallParams['dimensions'] = newDimension;
        newCallParams['metrics'] = newMetric;
        newCallParams['filters'] = filters;
        callRubicon(newCallParams, handleResponse.bind(this, newIndex, filters));
    }
}

function handleErrorResponse(errorResponse) {
    if (typeof errorResponse['result'] !== 'undefined') {
        try {
            var result = JSON.parse(errorResponse['result']);
            if (!errorResponse.error) errorResponse.error = '';
            errorResponse.error += result['message'] || result['errorMessage'] || '';
        } catch (e) {
            return;
        }
    }

    writerErrors.write({
        'statusCode': errorResponse.statusCode || '',
        'error': errorResponse.error || '',
        'path': errorResponse.path || ''
    })
}

function handleResponse() {
    var data, newIndex, filters;
    if (arguments.length === 1) {
        data = arguments[0];
    } else {
        newIndex = arguments[0];
        filters = arguments[1];
        data = arguments[2];
    }

    if (typeof data['result'] !== 'undefined') {

        try {
            var result = JSON.parse(data['result']);
        } catch (e) {
            return;
        }

        try {
            if (typeof result['data'] !== 'undefined' && typeof result['data']['items'] !== 'undefined') {
                var items = result['data']['items'];
                if (typeof newIndex !== 'undefined'
                    && typeof config.parameters['dimensionsFilter'] !== 'undefined'
                    && !((newIndex + 1) > config.parameters['dimensionsFilter'].length)
                ) {
                    var params = util._extend(config.parameters);
                    if (typeof params['metricFilter'] !== 'undefined' && params['metricFilter'].length > 0) {
                        var newMetric = getColumnNamesForType([params['metricFilter'][0]], 'Metric')[0];
                        var newDimension = getColumnNamesForType([params['dimensionsFilter'][newIndex]], 'Dimension')[0];

                        for (var key in items) {

                            if (!items.hasOwnProperty(key)) {
                                continue;
                            }
                            var item = items[key];
                            if (typeof item[newMetric] !== 'undefined' && parseFloat(item[newMetric]) > 0) {
                                callGranularRubicon(
                                    newIndex,
                                    filters + 'dimension:' + newDimension + '==' + item[newDimension] + ';'
                                );
                            }
                        }
                    }
                } else {
                    for (var i in items) {
                        if (items.hasOwnProperty(i)) {
                            if (config.parameters.addDateToOutput) {
                                items[i]['date'] = outputDate;
                            }

                            if (typeof config.parameters.preSaveFilter !== 'undefined'
                                && config.parameters.preSaveFilter.length > 0) {
                                if (preSaveFilter(items[i])) {
                                    writer.write(items[i]);
                                }
                            } else {
                                writer.write(items[i]);
                            }
                        }
                    }
                }
            } else {
                handleErrorResponse({
                    'statusCode': data.statusCode,
                    'error': 'no items',
                    'path': data.path
                });
            }
        } catch (e) {
            handleErrorResponse({
                'statusCode': data.statusCode,
                'error': e,
                'path': data.path
            });
        }
    }
}

function preSaveFilter(item) {
    var filter = config.parameters.preSaveFilter;
    var re, i, column;
    // TODO - refactor match + getColumn .. - do it only on init
    var columns = filter.match(/#(.*?)#/g);
    if (!!columns) {
        try {
            for (i in columns) {
                if (!columns.hasOwnProperty(i)) {
                    continue;
                }
                column = getColumnNamesForType([columns[i].replace(/#/g, '')])[0];
                re = new RegExp(columns[i], "g");
                if(typeof item[column] !== 'undefined') {
                    filter = filter.replace(re, item[column]);
                }
            }

            if (!new Function('return (' + filter + ');')()) {
                return false;
            }
        } catch (e) {
            console.log('Error in filter');
            return true;
        }
    }

    return true;
}

function getColumnNamesForType(names, forType) {
    var buffer = [];
    if (names) {
        for (var kname in names) {
            if (!names.hasOwnProperty(kname)) {
                continue;
            }
            var name = names[kname];
            for (var key in conversions) {
                if (!conversions.hasOwnProperty(key)) {
                    continue;
                }
                var spec = conversions[key];
                if (
                    (spec['Label'] == name || spec['API Column Key'] == name)
                    && (spec['Type'] == forType || !forType)
                ) {
                    buffer.push(spec['API Column Key']);
                }
            }
        }
    }
    return buffer;
}

// process.stdin.resume();//so the program will not close instantly

function exitHandler(options, err) {

    if (options.cleanup) console.log('clean');
    if (err) console.log(err.stack);
    if (options.exit) process.exit(0);

    writer.end();
    writerErrors.end();
    process.exit(0);
}

//do something when app is closing
process.on('exit', exitHandler.bind(null, {cleanup: true}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit: true}));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {exit: true}));

rubiconCaller();