
var Q = require("q");
var FS = require("q-io/fs");
var HTTP = require("q-io/http");
var URL = require("url");
var S3 = require("./s3");
var Reader = require("q-io/reader");
var SauceLabs = require("saucelabs");
var webdriver = require("wd");
var publishBundle = require("./publish-bundle");
var getAnnotations = require("./annotations");
var getCredentials = require("./credentials");

module.exports = run;
function run(location, annotations, configurationsPath, credentialsPath, timeout) {
    return Q([
         getConfigurations(configurationsPath),
         getCredentials(credentialsPath)
    ])
    .spread(function (configurations, credentials) {
        var saucelabs = Q(new SauceLabs({
            username: credentials.SAUCE_USERNAME,
            password: credentials.SAUCE_ACCESS_KEY
        }));
        var s3 = new S3({
            bucket: credentials.S3_BUCKET,
            key: credentials.S3_ACCESS_KEY_ID,
            secret: credentials.S3_ACCESS_KEY
        });
        return Reader(configurations)
        .map(function (configuration) {
            return runConfiguration(
                location,
                annotations,
                configuration,
                credentials,
                saucelabs,
                timeout
            )
            .then(function (result) {
                return {
                    configuration: configuration,
                    results: result
                };
            }, function (error) {
                console.log("ERROR", error);
                // Continue regardless of whether there's an error.
                return {
                    configuration: configuration,
                    results: {
                        passed: false,
                        error: error
                    }
                };
            });
        }, null, 1)
        .all()
    });
}

function getConfigurations(path) {
    return FS.read(path || "saucelabs-configurations.json", {charset: "utf-8"})
    .then(JSON.parse);
}

function runConfiguration(location, annotations, configuration, credentials, saucelabs, timeout) {

    var browser = webdriver.promiseRemote(
        "ondemand.saucelabs.com",
        80,
        credentials.SAUCE_USERNAME,
        credentials.SAUCE_ACCESS_KEY
    );

    browser.on('status', function(info){
      console.log("WD-STATUS>", info);
    });

    browser.on('command', function(meth, path){
      console.log("WD-COMMAND>", meth, path);
    });

    configuration.name = annotations.name || "job";
    configuration.tags = annotations.tags;
    configuration.build = annotations.build;
    configuration["custom-data"] = annotations;

    var result;
    return browser.init(configuration)
    .then(function (session) {
        var sessionId = session[0];
        console.log("SESSION", sessionId);

        return browser.get(location)
        .then(function () {
            return poll(function () {
                console.log("POLL");
                return browser.eval("window.global_test_results")
            }, 100)
        })
        .timeout(timeout || (20 * 1e3))
        .then(function (_result) {
            console.log("RESULT", _result);
            result = _result;
            return saucelabs.ninvoke("updateJob", sessionId, {
                passed: result.passed,
                public: true
            });
        }, function (error) {
            console.log("ERROR", error);
            return saucelabs.ninvoke("updateJob", sessionId, {
                passed: false,
                error: true,
                public: true,
                "custom-data": {
                    "error": error.stack
                }
            });
        });
    })
    .finally(function () {
        return browser.quit()
    })
    .then(function () {
        return result;
    });

}

function poll(callback, ms) {
    return callback().then(function (value) {
        if (value) {
            return value;
        } else {
            return Q().delay(ms).then(function () {
                return poll(callback, ms);
            });
        }
    })
}

function captureMatrix(credentials, annotations) {
    var s3 = new S3({
        bucket: credentials.S3_BUCKET,
        key: credentials.S3_ACCESS_KEY_ID,
        secret: credentials.S3_ACCESS_KEY
    });
    return HTTP.read("https://saucelabs.com/browser-matrix/kriskowal-asap.svg")
    .then(function (content) {
        return s3.put(URL.resolve(annotations.trainPath, "saucelabs-matrix.svg"), content, "image/svg+xml");
    });
}

function main() {
    return Q([
        getCredentials(),
        getAnnotations()
    ]).spread(function (credentials, annotations) {
        // Use an adhoc location for the bundle. The annotation path is
        // reserved for build products.
        return publishBundle(FS.join(process.argv[2]), null, credentials)
        .then(function (location) {
            return run(location, annotations, process.argv[3])
        })
        .then(function (results) {
            return captureMatrix(credentials, annotations)
            .thenResolve(results);
        });
    })
    .done(function (results) {
        console.log(JSON.stringify(results, null, 4));
    });
}

if (require.main === module) {
    main();
}
