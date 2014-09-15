var CronJob = require('cron').CronJob;
var request = require('superagent');

var db = require("mongojs").connect("healthcheckDB", ["currentServices"]);

var RPS = require("node-redis-pubsub-fork"),
    pubsubChannel;

var cronJobs = {};

pubsubChannel = new RPS({ scope: "messages" });

pubsubChannel.on("healthcheck:submit", function(data) {
    console.log("New healthcheck created for " + data.name + " querying " + data.localURL + " with expectation " + data.expectedResBody);
    
    // add the cron healthcheck to the healthcheck database
    db.currentServices.save({"name": data.name, 
                           "localURL": data.localURL, 
                           "frequency": data.frequency, 
                           "expectedResBody": data.expectedResBody,
                           "expectedResStatus": data.expectedResStatus
                          }, function(err, saved) {
      if( err || !saved ) {
          console.log("Service to be checked NOT saved in Healthcheck DataBase");
          data.failed = "true";
          pubsubChannel.emit("healthcheck:submitResult", data);
      } else {
          console.log("Service saved in Healthcheck DataBase");
          pubsubChannel.emit("healthcheck:submitResult", data);
      }
    });
    
    // create the cron job, which successively calls the checkService() method.  The callback function which emits a message on "healthcheck:stopped" is called when the cron job ends.
    var newJob = new CronJob(data.frequency, function(){
        checkService(data);
    }, 
    function() {
        pubsubChannel.emit("healthcheck:stopped", data);
    }, true);
    
    // add created cronJob to the cronJobs map
    cronJobs[data.name] = newJob;
});

pubsubChannel.on("healthcheck:queryHealth", function(data) {
    db.currentServices.find({"name": data.name}).toArray(function(err, queryHealthRes) {
        if (!err) {
            console.log(queryHealthRes);
            console.log("should emit result now");
            pubsubChannel.emit("healthcheck:queryHealthResult", {"name": data.name, "healthcheckSettings": queryHealthRes});
        }
        else {
            pubsubChannel.emit("healthcheck:queryHealthResult", {"name": data.name, "healthcheckSettings": []});
        }
    });
});

pubsubChannel.on("healthcheck:update", function(data) {
    console.log("Updating healthcheck DB entry for %s with new details %s %s %s %s", data.name, data.localURL, data.frequency, data.expectedResBody, data.expectedResStatus);
    
    db.open(function(err, db) {
        db.collection("currentServices").findAndModify(
            { name: data.name },
            [['_id','asc']],
            { $set: { localURL: data.localURL, frequency: data.frequency, expectedResBody: data.expectedResBody, expectedResStatus: data.expectedResStatus } },
            function(err, object) {
                if (err) {
                    data.failed = "true";
                    pubsubChannel.emit("healthcheck:updateResult", data);
                    console.warn(err.message);
                } else {
                    var listener = function(stoppedData) {
                        if ((stoppedData.name==data.name) && (delete cronJobs[data.name])) {
                            console.log(stoppedData.name + " " + data.name);
                            var newJob = new CronJob(data.frequency, function() {
                                checkService(data);
                            },
                            function() {
                                pubsubChannel.emit("healthcheck:stopped", data);
                            }, true);
                            cronJobs[data.name] = newJob;
                            pubsubChannel.emit("healthcheck:updateResult",data);
                        } else {
                            data.failed = "true";
                            pubsubChannel.emit("healthcheck:updateResult", data);
                        }
                    }
                    pubsubChannel.on("healthcheck:stopped", listener);
                    pubsubChannel.onceIf("healthcheck:updateResult", function(data) {
                        pubsubChannel.off("healthcheck:stopped", listener);
                    }, "failed", null);
                     // 'stop' calling too quickly for listener, so stopped called after listener declaration
                    cronJobs[data.name].stop();
                }
            }
        );
    });
});

pubsubChannel.on("healthcheck:delete", function(data) {
    console.log("Deleting healthcheck DB entry for %s and associated cron job", data.name);
    
    db.currentServices.remove({ name: data.name }, function(err, object) {
        if (err) {
            data.failed = "true";
            pubsubChannel.emit("healthcheck:deleteResult", data);
            console.warn(err.message);
        } else {
            // declare pubsub listener
            var listener = function(stoppedData) {
                if (stoppedData.name == data.name) {
                    if (delete cronJobs[data.name]) {
                        pubsubChannel.emit("healthcheck:deleteResult", data);
                    } else {
                        data.failed = "true";
                        pubsubChannel.emit("healthcheck:deleteResult", data);
                    }
                }
            };
            pubsubChannel.on("healthcheck:stopped", listener);
            pubsubChannel.onceIf("healthcheck:deleteResult", function(deletedData) {
                pubsubChannel.off("healthcheck:stopped", listener);
            }, "failed", null);
            // 'stop' calling too quickly for listener, so stopped called after listener declaration
            cronJobs[data.name].stop();       
        }
    });
});



function checkService(data){
    var req = request.get(data.localURL);
    req.end(function(res) {
        console.log("response = " + res.body);

        if (res.status != data.expectedResStatus ||
            res.body != data.expectedResBody ){
            pubsubChannel.emit("healthcheck:failed", {name: data.name, localURL: data.localURL, expectedResBody: data.expectedResBody, actualResBody: res.body, expectedResStatus: data.expectedResStatus, actualResStatus: res.status, result: "failing", time: new Date() });
        } else {
            pubsubChannel.emit("healthcheck:passed", {name: data.name, localURL: data.localURL, expectedResBody: data.expectedResBody, actualResBody: res.body, expectedResStatus: data.expectedResStatus, actualResStatus: res.status, result: "passing", time: new Date() });
        }
    });
}