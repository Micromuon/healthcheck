var request = require('superagent');
var mockServer = require("./testservice.js");
require('../healthcheck.js'); //Boot up the server for tests
var host = 'http://localhost:11000';
var assert = require("assert"),
    RPS = require("node-redis-pubsub-fork");
var db = require("mongojs").connect("healthcheckDB", ["currentServices"]);
var timers = require("timers");

//after(function(){
//    db.currentServices.drop();
//});

var pubsubChannel = new RPS({ scope: "messages" });

var correctServiceDetails = {name: "testservice", localURL: "http://localhost:16000", frequency: "*/1 * * * * *", expectedResBody: "We are the knights who say ni", expectedResStatus: 200};
var wrongServiceDetails = {name: "failservice", localURL: "http://localhost:16000", frequency: "*/1 * * * * *", expectedResBody: "We are the knights who say ecckyecckyecckyfwootangwhoopah", expectedResStatus: 200};
var newServiceDetails = {name: "failservice", localURL: "http://localhost:16000", frequency: "*/1 * * * * *", expectedResBody: "We are the knights who say ni", expectedResStatus: 200};

describe('test healthCheck: ', function(){

    it('returns correct response when healthy service submitted', function(done){
        this.timeout(30000);
        pubsubChannel.once("healthcheck:passed", function(data){
            console.log(data);
            // Check returning expected data
            assert.equal(data.name, "testservice");
            assert.equal(data.expectedResBody, data.actualResBody);
            assert.equal(data.expectedResStatus, data.actualResStatus);
            // Check returning "passed" as submitted service was healthy
            assert.equal(data.result, "passing");
            assert.notEqual(data.time, null);
            done();
        });
        pubsubChannel.emit("healthcheck:submit", correctServiceDetails);
    });
    
    it('returns failure message when unhealthy service submitted', function(done){
        this.timeout(7000);
        pubsubChannel.once("healthcheck:failed", function(data){
            console.log(data);
            // Check returning expected data
            assert.equal(data.name, "failservice");
            assert.notEqual(data.expectedResBody, data.actualResBody);
            assert.equal(data.expectedResStatus, data.actualResStatus);
            // Check returning "passed" as submitted service was healthy
            assert.equal(data.result, "failing");
            assert.notEqual(data.time, null);
            done();
        });
        pubsubChannel.emit("healthcheck:submit", wrongServiceDetails);
    });
    
    it('saves existing cron jobs to local service database', function(done) {
        // wait for saving to occur
        timers.setTimeout(function() {
                // find the entry in the database and check that it is as was submitted
                db.currentServices.find({"name":correctServiceDetails.name}).toArray(function(err, result) {
                    if (err || !result) {
                        console.log("No healthcheck job found for cron response.");
                    } else {
                        assert.equal(result[0].name, correctServiceDetails.name);
                        assert.equal(result[0].localURL, correctServiceDetails.localURL);
                        assert.equal(result[0].frequency, correctServiceDetails.frequency);
                        assert.equal(result[0].expectedResBody, correctServiceDetails.expectedResBody);
                        assert.equal(result[0].expectedResStatus, correctServiceDetails.expectedResStatus);
                        done();
                    }
                });
        }, 1000);
    });
    
    it('allows querying of healthcheck settings by service name', function(done) {
        this.timeout(7000);
        pubsubChannel.once("healthcheck:queryHealthResult", function(data) {
            db.currentServices.find({"name": correctServiceDetails.name}).toArray(function(err, result) {
                console.log(result);
                    if (err || !result) {
                        console.log("No healthcheck job found.");
                    } else {
                        assert.equal(result[0].name, data.name);
                        assert.equal(result[0].localURL, data.healthcheckSettings[0].localURL);
                        assert.equal(result[0].frequency, data.healthcheckSettings[0].frequency);
                        assert.equal(result[0].expectedResBody, data.healthcheckSettings[0].expectedResBody);
                        assert.equal(result[0].expectedResStatus, data.healthcheckSettings[0].expectedResStatus);
                        done();
                    }
                });
        });
        pubsubChannel.emit("healthcheck:queryHealth", {name: correctServiceDetails.name});
    });
    
    it('deletes a cron job when requested and removes it from the healthcheckDB', function(done) {
        this.timeout(7000);
        pubsubChannel.onceIf("healthcheck:deleteResult", function(data) {
            assert.equal(data.name, correctServiceDetails.name);
            done();
        }, "failed", null);
        pubsubChannel.emit("healthcheck:delete", correctServiceDetails);
    });
    
    
    it('updates the healthcheckDB on request and restarts associated cron job', function(done) {
        this.timeout(7000);
        pubsubChannel.emit("healthcheck:update", newServiceDetails);
        timers.setTimeout(function() {
            db.currentServices.find({"name":newServiceDetails.name}).toArray(function(err, result) {
                    if (err || !result) {
                        console.log("No healthcheck job found.");
                    } else {
                        assert.equal(result[0].name, newServiceDetails.name);
                        assert.equal(result[0].localURL, newServiceDetails.localURL);
                        assert.equal(result[0].frequency, newServiceDetails.frequency);
                        assert.equal(result[0].expectedResBody, newServiceDetails.expectedResBody);
                        assert.equal(result[0].expectedResStatus, newServiceDetails.expectedResStatus);
                        pubsubChannel.on("healthcheck:passed", function(data) {
                            if (data.name == newServiceDetails.name)
                                done(); 
                        });
                    }
                });
        }, 1000);
    });
});

