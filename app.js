#!/usr/bin/env node

var bodyParser = require('body-parser'),
  cookieParser = require('cookie-parser'),
  cp = require("child_process"),
  errorHandler = require('errorhandler'),
  express = require('express'),
  flash = require('flash'),
  fs = require("fs"),
  methodOverride = require('method-override'),
  path = require("path"),
  session = require('express-session'),
  YUI = require("yui3").YUI;

var app = module.exports = express(),
  appPath = process.argv[1].match(/^(.*)\/[^\/]+$/)[1];

process.chdir(appPath);

// Configuration
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');
app.use(bodyParser.json());
// app.use(methodOverride());
app.use(cookieParser());
app.use(session({
  secret: "monkey wrench",
  resave: false,
  saveUninitialized: false
}));
app.use(flash());
app.use(express.static(__dirname + '/public'));


var env = process.env.NODE_ENV || 'development';
if (env === 'development') {
  app.use(errorHandler({
    dumpExceptions: true,
    showStack: true
  }));
}

// Routes

YUI().use("json", "substitute", function (Y) {
  var HandbrakeServerConfig = require('./HandbrakeServerConfig');
  var rootFolder = HandbrakeServerConfig.main.rootFolder,
    outputFolder = HandbrakeServerConfig.main.outputFolder,
    profiles = HandbrakeServerConfig.profiles,
    handbrake,
    config = {
      jobs: {},
      queue: [],
      doneQueue: [],
      currentJobID: null
    };

  var Job = function (spath, profileID) {
    this.sourcePath = spath;
    this.profile = profileID;
    this.name = path.basename(spath);
    this.outputPath = spath.replace(rootFolder, outputFolder).replace(path.extname(spath), "");
    this.args = profiles[profileID].split(" ");
    this.args[1] = Y.substitute(this.args[1], {
      inputFile: this.sourcePath
    });
    this.args[3] = Y.substitute(this.args[3], {
      outputFile: this.outputPath
    });
    this.complete = false;
    this.deleteSource = false;
    this.progress = 0;
    this.status = "created";
    this.id = Y.stamp(this);
  };

  var init = function () {
    loadConfig(function () {
      checkJobs();

      if (!module.parent) {
        app.listen(HandbrakeServerConfig.main.listenPort);
        console.log("Express server listening on port %d", HandbrakeServerConfig.main.listenPort);
      }
    });
  };

  var addJob = function (path, profileID, deleteSource, cb) {
    cb = cb || function () {};
    validatePath(path, function (check) {
      if (!check.success) {
        return;
      } else {
        if (!profiles[profileID]) {
          cb({
            success: false,
            msg: "Not a valid profileID"
          });
          return;
        }
        var job = new Job(path, profileID);
        if (job.sourcePath.indexOf(rootFolder) !== 0) {
          // TODO: Better error nessages. What does this mean?
          cb({
            success: false,
            msg: "Path not in within root path"
          });
          return;
        }
        if (deleteSource) {
          job.deleteSource = true;
        }
        config.jobs[job.id] = job;
        config.queue.push(job.id);
        job.status = "Queued";
        saveConfig(function () {
          checkJobs();
          cb({
            success: true,
            msg: "Job Added",
            jobID: job.id
          });
          return;
        });
      }
    });
  };

  var readdJob = function (job) {
    var msg;
    if (job) {
      if (config.queue.indexOf(job.id) < 0) {
        config.queue.push(
          config.doneQueue.splice(
            config.doneQueue.indexOf(job.id),
            1
          )
        );
        job.status = "Requeued";
        checkJobs();
        saveConfig();
        msg = {
          success: true,
          msg: "Job readded"
        };
      } else {
        msg = {
          success: false,
          msg: "Job already in queue"
        };
      }
    } else {
      msg = {
        success: false,
        msg: "Job not found"
      };
    }
    return msg;
  }

  var removeJob = function (jobID) {
    var jobIndex = config.queue.indexOf(jobID);
    if (jobIndex < 0) {
      return {
        success: false,
        msg: "Job not in Queue"
      };
    } else {
      config.doneQueue.push(config.queue.splice(jobIndex, 1)[0]);
    }
    if (jobID === config.currentJobID && handbrake && handbrake.pid) {
      handbrake.kill("SIGINT");
      config.jobs[config.currentJobID].status = "Terminated by user";
      saveConfig();
      return {
        success: true,
        msg: "Killed job"
      };
    } else {
      config.queue.splice(config.queue.indexOf(jobID), 1);
      config.jobs[jobID].status = "Canceled";
      saveConfig();
      return {
        success: true,
        msg: "Removed job"
      };
    }
  };

  var checkJobs = function () {
    console.info("Queue Length: " + config.queue.length);
    if(config.queue.length > 0){
      console.info("currentJobID: " + config.currentJobID);
    }
    console.info("handbrake: " + handbrake);
    if (config.queue.length && (!config.currentJobID || !handbrake)) {
      startJob(config.queue[0]);
    }
  };

  var mkdirP = function (p, mode, f) {
    var cb = f || function () {};
    if (p.charAt(0) !== '/') {
      cb('Relative path: ' + p);
      return;
    }

    var ps = path.normalize(p).split('/');
    fs.exists(p, function (exists) {
      if (exists) cb(null);
      else mkdirP(ps.slice(0, -1).join('/'), mode, function (err) {
        if (err && err.errno !== process.EEXIST) {
          cb(err);
        } else {
          fs.mkdir(p, mode, cb);
        }
      });
    });
  };

  var startJob = function (jobID) {
    if (!handbrake || handbrake.pid === null) {
      mkdirP(path.dirname(config.jobs[jobID].outputPath), 0777);

      config.currentJobID = jobID;
      handbrake = cp.spawn("HandBrakeCLI", config.jobs[jobID].args);
      handbrake.stdout.on("data", update);
      handbrake.stderr.on("data", update);
      handbrake.on("exit", onComplete);
    } else {
      index = config.queue.indexOf(jobID);
      if (index < 0) {
        config.queue.shift(jobID);
      } else {
        config.queue.shift(config.queue.splice(index, 1));
      }
    }
  };

  var update = function (data) {
    var updateMsg = data.toString(),
      percent = parseFloat(updateMsg.match(/\d+\.\d+\ \%/)),
      job = config.jobs[config.currentJobID],
      h, m, s;

    if (updateMsg.match(HandbrakeServerConfig.main.handbrakeExit)) {
      job.complete = true;
    }

    if (percent) {
      if (updateMsg.match("ETA")) {
        h = updateMsg.match(/(\d\d)h/)[1] + ":";
        m = updateMsg.match(/(\d\d)m/)[1] + ":";
        s = updateMsg.match(/(\d\d)s/)[1],
          job.status = percent + "% complete, Time remaining " + h + m + s + ".";
      } else {
        job.status = percent + "% complete.";
      }
    } else {
      if (job.complete) {
        job.status = "Job completed successfully.";
      } else {
        job.status = "Job starting.";
      }
    }
  };

  var onComplete = function (code) {
    var job = config.jobs[config.currentJobID];

    console.log("job complete code: " + code);
    handbrake = null;

    if (code === 1) {
      job.status = "Handbrake crashed.";
    } else {
      if (job.complete) {
        if (job.deleteSource) {
          fs.unlink(job.sourcePath, function (err) {
            if (!err) {
              console.log("File deleted: " + job.sourcePath);
            }
          });
        }
      } else {
        job.status = "Job Failed";
      }
    }
    config.doneQueue.push(config.queue.shift(config.currentJobID));
    config.currentJobID = null;
    saveConfig();
    checkJobs();
  };

  var moveJobTo = function (jobID, index) {
    index = parseInt(index) < 1 ? 1 : parseInt(index);
    index = index > config.queue.length - 1 ? config.queue.length - 1 : index;
    var jobIndex = config.queue.indexOf(jobID);
    if (jobIndex < 0) {
      return {
        success: false,
        msg: "Job not in queue."
      };
    } else {
      config.queue.splice(index, 0, config.queue.splice(jobIndex, 1)[0]);
      saveConfig();
      return {
        success: true,
        msg: "Job moved to position " + (index + 1) + "."
      };
    }
  };

  var saveConfig = function (cb) {
    cb = cb || function () {};
    fs.writeFile("./config.json", Y.JSON.stringify(config), function (err) {
      if (err) {
        Y.log("Error saving config", "error");
      } else {
        cb();
      }
    });
  };

  var loadConfig = function (cb) {
    cb = cb || function () {};
    fs.realpath("./config.json", function (err) {
      if (err) {
        saveConfig(function () {
          loadConfig(cb);
        });
      } else {
        fs.readFile("./config.json", function (err, data) {
          config = Y.JSON.parse(data);
          cb();
        });
      }
    });
  };
  // TODO: Better error nessages.
  var validatePath = function (path, callback) {
    callback = callback || function () {};
    if (!path) {
      callback({
        success: false,
        msg: "Please provide a path"
      });
      return;
    }
    if (path[0] !== '/') {
      callback({
        success: false,
        msg: "Not an absolute path"
      });
      return;
    }
    fs.realpath(path, function (err) {
      if (err) {
        callback({
          success: false,
          msg: "Not a valid path"
        });
      } else {
        callback({
          success: true
        });
      }
    });
  };

  var addFolder = function (path, profile, deleteSource, cb) {
    cb = cb || function () {};
    var check = validatePath(path, function (check) {
      if (!check.success) {
        cb([check]);
      } else {
        findAllMediaFiles(path, function (files) {
          files.sort();
          msgs = [];
          if (files.length) {
            Y.log("Found " + files.length + " media files");
            var n = files.length;
            files.forEach(function (file) {
              addJob(file, profile, deleteSource, function (msg) {
                Y.log("Pushing job: " + file);
                msgs.push(msg);
                n--;
                Y.log(n);
                if (n === 0) {
                  cb(msgs);
                }
              });
            });
          } else {
            // TODO: Must be of type X?
            cb([{
              success: false,
              msg: "No suitable files found"
            }]);
          }
        });
      }
    });
  };

  var clearCompleteJobs = function () {
    var deleted = 0;
    for (var jobID in config.jobs) {
      if (config.jobs.hasOwnProperty(jobID)) {
        if (config.queue.indexOf(jobID) < 0) {
          delete config.jobs[jobID];
          deleted++;
        }
      }
    }
    config.doneQueue = [];
    return {
      success: true,
      msg: deleted + " completed jobs cleared"
    };
  }

  var isRightFileType = function (extn) {
    return (extn === 'mkv' || extn === 'avi' || extn === 'ts');
  };

  var findAllMediaFiles = function (path, cb) {
    cb = cb || function () {};
    var rightFiles = [];
    fs.readdir(path, function (err, files) {
      if (err || !files.length) {
        console.log(err);
        cb(rightFiles);
        return;
      }

      var i = files.length;

      var checkDone = function (file) {
        i--;
        if (i < 1) {
          cb(rightFiles);
        }
      };

      files.forEach(function (file) {
        fs.stat(path + "/" + file, function (err, fileStat) {
          if (err) {
            console.log(err);
            checkDone();
          } else if (fileStat.isDirectory()) {
            findAllMediaFiles(path + "/" + file, function (subFiles) {
              rightFiles = rightFiles.concat(subFiles);
              checkDone();
            });
          } else {
            if (file.match(/^.*\.(.*)$/)) {
              var extn = file.match(/^.*\.(.*)$/)[1].toLowerCase();
              if (isRightFileType(extn)) {
                rightFiles.push(path + '/' + file);
              }
            }
            checkDone();
          }
        });
      });
    });
  };

  var flashMsgs = function (req, msgs) {
    if (msgs.forEach) {
      msgs.forEach(function (msg) {
        if (msg.success) {
          req.flash('msgs', msg.msg);
        } else {
          req.flash('errors', msg.msg);
        }
      });
    }
  };

  /*********************************************************/
  /*********************** Routes **************************/
  /*********************************************************/

  app.get('/', function (req, res) {
    var queuedJobs = [],
      completedJobs = [];
    for (var i = 0; i < config.queue.length; i++) {
      var job = config.jobs[config.queue[i]];
      queuedJobs.push(job);
    }

    for (var i = 0; i < config.doneQueue.length; i++) {
      var job = config.jobs[config.doneQueue[i]];
      completedJobs.push(job);
    }

    res.render('index', {
      title: 'Hand Brake Server',
      queuedJobs: queuedJobs,
      completedJobs: completedJobs,
      profiles: profiles,
      msgs: req.flash("msgs"),
      errors: req.flash("errors"),
      rootFolder: rootFolder + "/"
    });
  });

  app.get("/json/folder-search", function (req, res) {
    var json = {
        results: []
      },
      reqPath = req.query.path;
    if (Y.Lang.isString(reqPath) && reqPath.indexOf(rootFolder) === 0) {
      var pieces = reqPath.split("/"),
        search = pieces.pop(),
        folder = pieces.join("/");
      fs.realpath(folder, function (err) {
        if (err) {
          res.send(json);
        } else {
          fs.readdir(folder, function (err, files) {
            if (err) {
              res.send(json)
            } else {
              files.forEach(function (file) {
                if (search === "" || file.toLowerCase().match(search.toLowerCase())) {
                  var result = {
                    path: folder + "/" + file
                  };
                  if (fs.statSync(folder + "/" + file).isDirectory()) {
                    result.path += "/";
                  }
                  json.results.push(result);
                }
              });
              res.send(json)
            }
          });
        }
      });
    } else {
      json.results.push({
        path: rootFolder + "/"
      });
      res.send(json);
    }
  });

  app.get("/fragments/queue", function (req, res) {
    var queuedJobs = [];

    for (var i = 0; i < config.queue.length; i++) {
      var job = config.jobs[config.queue[i]];
      queuedJobs.push(job);
    }

    res.render("queue", {
      queuedJobs: queuedJobs,
      layout: false
    });
  });

  app.get("/fragments/complete", function (req, res) {
    var completedJobs = [];

    for (var i = 0; i < config.doneQueue.length; i++) {
      var job = config.jobs[config.doneQueue[i]];
      completedJobs.push(job);
    }

    res.render("complete", {
      completedJobs: completedJobs,
      layout: false
    });
  });

  app.get('/add/', function (req, res) {
    addJob(path.normalize(req.query.path), req.query.profile, req.query.deleteSource, function (msg) {
      flashMsgs(req, [msg]);
      res.redirect("home");
    });
  });

  app.get('/json/add/', function (req, res) {
    addJob(path.normalize(req.query.path), req.query.profile, req.query.deleteSource, function (msg) {
      res.send([msg]);
    });
  });

  app.get('/readd/:jobID', function (req, res) {
    var msg = readdJob(config.jobs[req.params.jobID]);
    flashMsgs(req, [msg]);
    res.redirect("home");
  });

  app.get('/json/readd/:jobID', function (req, res) {
    var msg = readdJob(config.jobs[req.params.jobID]);
    res.send([msg]);
  });

  app.get('/add-folder/', function (req, res) {
    addFolder(path.normalize(req.query.path), req.query.profile, req.query.deleteSource, function (msgs) {
      flashMsgs(req, msgs);
      res.redirect("home");
    });
  });

  app.get('/json/add-folder/', function (req, res) {
    addFolder(path.normalize(req.query.path), req.query.profile, req.query.deleteSource, function (msgs) {
      res.send(msgs);
    });
  });

  app.get('/clear-completed/', function (req, res) {
    var msg = clearCompleteJobs();
    saveConfig(function () {
      flashMsgs(req, [msg]);
      res.redirect("home");
    });
  });

  app.get('/json/clear-completed/', function (req, res) {
    var msg = clearCompleteJobs();
    saveConfig(function () {
      res.send([msg]);
    });
  });

  app.get('/remove/:jobID', function (req, res) {
    var msg = removeJob(req.params.jobID);
    flashMsgs(req, [msg]);
    res.redirect("home");
  });

  app.get('/json/remove/:jobID', function (req, res) {
    var msg = removeJob(req.params.jobID);
    res.send([msg]);
  });

  app.get('/move-job-to/:jobID/:newIndex', function (req, res) {
    var msg = moveJobTo(req.params.jobID, req.params.newIndex);
    flashMsgs(req, [msg]);
    res.redirect("home");
  });

  app.get('/json/move-job-to/:jobID/:newIndex', function (req, res) {
    var msg = moveJobTo(req.params.jobID, req.params.newIndex);
    res.send([msg]);
  });

  init();
});
