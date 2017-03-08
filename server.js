/**
 * @module server.js
 * 
 * Starting point for server. Contains endpoint routing as well as socket
 * communication handling.
 */
'use strict';

// Express.JS middleware
var express = require('express'),
    config = require('./config'),
    MongoCon = require('./MongoCon'),
    playerConfig = require('./PlayerConfig'),
    _ = require('lodash'),
    async = require('async'),
    Player = require('player'),
    fs = require('fs'),
    path = require('path'),``
    http = require('http'),
    Socket = require('socket.io'),
    passport = require('passport'),
    LocalStrategy = require('passport-local').Strategy;

/**
 * @function passport.use(LocalStrategy, function (username, password, done))
 * @param username - Client username
 * @param password - Client password
 * @param done - callback function
 * 
 * Defines a local authentication method for Passport.JS
 */
passport.use(new LocalStrategy(
  function(username, password, done) {
    if (username === playerConfig.username && password === playerConfig.password)
      return done(null, {name: "admin"});

    return done(null, false);
  }
));

/**
 * @function passport.seriazlieUser(function (user, cb))
 * @param {User} user - User credientials
 * @param {function} cb -callback function
 * 
 * Serialized the user from the session
 */
passport.serializeUser(function(user, cb) {
  cb(null, user);
});

/**
 * @function passport.deserializeUser(function (user, cb))
 * @param {User} user - User credentials
 * @param {function} cb - Callback function
 * 
 * Deserialize the user from the session
 */
passport.deserializeUser(function(user, cb) {
  cb(null, user);
});

/**
 * @function auth
 * @param {HTTP Request} req - HTTP Request object 
 * @param {HTTP Response} res - HTTP Response object
 * @param {function} next - Callback function 
 * 
 * Sends a 401 if the user is not authenticated. Otherwise, continue to display
 * the requested page.
 */
var auth = function(req, res, next){
  if (!req.isAuthenticated())
    res.sendStatus(401);
  else
    next();
};

var PATH = playerConfig.PATH;
var player, currSong;
var playing = false;
var paused = false;

// Handles playback of music files
player = new Player([]);

// Set the NODE ENV to development if it has not yet been set
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

var app = express();

var http = http.Server(app);

var io = Socket(http);

/**
 * @function io.on('connection')
 * @param socket - WebSocket of the server
 * 
 * Define Socket.IO handlers
 */
io.on('connection', function(socket){

  /**
   * @function socket.on('voteup')
   */
  socket.on('voteup', function(msg){
    io.emit('refreshList');
  });

  /**
   * @function socket.on('changeVol')
   * @param {String} msg - Value to the set the volume to
   */
  socket.on('changeVol', function(msg){
    player.setVolume(msg);
  });

});

// Enable Express middleware
app.set('views', __dirname + '/src/views');
app.set('view engine', 'jade');
app.locals.pretty = true;
app.use(require('morgan')('combined'));
app.use(require('cookie-parser')());
app.use(require('body-parser').urlencoded({ extended: true }));
app.use(require('express-session')({ secret: 'keyboard cat', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

// Static public directory for users to load resources from
app.use(express.static(__dirname + '/public'));

// Initialize database connection
var mongocon = new MongoCon(config.mongo.uri);
mongocon.init();

/**
 * @function updatePlayList
 * 
 * Sets the new songs to be voted on
 */
var updatePlayList = function(){

  mongocon.playcur(function(err, res){
    var path = res.path;

    // Create a new player object with the given song list
    player = new Player(path)
              // Play a new song 
              .on('playing', function(song){
                playing = true;
                paused = false;
                io.emit('songChanged', song);
                mongocon.resetVotes(song.src);
                currSong = song;
              })
              // If an error is encountered during playback of file, update the
              // song list and restart the player.
             .on('error', function(err){
               playing = false;
               paused = false;
               updatePlayList();
              })
             .play();
  });
}

// API Handlers //

// Returns whether or not the player is currently playing
app.get('/api/playing', function(req, res) {
  return res.json({ playerState: playing});
});

// Returns whether or not the player is currently paused
app.get('/api/paused', function(req, res) {
  return res.json({ pausedState: paused});
});

// Returns the name of the current song
app.get('/api/current', function(req, res) {
  return res.json({ current: currSong});
});

// Returns the name of the songs currently in the queue
app.get('/songs', function(req, res) {
  var cb = function(err, data) {
    if (err) {
      res.end(err);
    } else {
      res.json(data);
    }
  };
  mongocon.getSongs(cb);
});

// Upvote a song with the identifier of 'id'
app.get('/upvote/:id', function(req, res) {
  var songId = req.params.id;
  mongocon.upvote(songId, function(){res.json({'success':'upvoted '+ songId});});

});

/**
 * @function app.get('/pause')
 * @param {HTTP Request} req - HTTP Request
 * @param {HTTP Response} res - HTTP Response
 * 
 * Admin requests to start or continue playback
 */
app.get('/play', auth, function(req, res) {

  //stop an already plaing item
  if(typeof player != "undefined")
  {
    player.stop();
  }

  updatePlayList();

  res.redirect('/');
});

/**
 * @function app.get('/pause')
 * @param {HTTP Request} req - HTTP Request
 * @param {HTTP Response} res - HTTP Response
 * 
 * Admin requests to play the next song
 */
app.get('/next', auth, function(req, res){

  if(typeof player === "undefined")
  {
    res.send("No player instance detected!");
    return;
  }

  player.stop();
  player.next();

  res.redirect('/');

});

/**
 * @function app.get('/pause')
 * @param {HTTP Request} req - HTTP Request
 * @param {HTTP Response} res - HTTP Response
 * 
 * Admin requests to stop the current song
 */
app.get('/stop', auth, function(req, res){
  player.stop();
  playing = false;
  paused = false;

  currSong = '';
  res.redirect('/');

});

/**
 * @function app.get('/pause')
 * @param {HTTP Request} req - HTTP Request
 * @param {HTTP Response} res - HTTP Response
 * 
 * Admin requests to pause the current song
 */
app.get('/pause', auth, function(req, res){
  player.pause();
  playing = !playing;
  paused = !paused;
  res.redirect('/');
});

/**
 * @function app.get('/reload')
 * 
 * Endpoint to refresh the client's song data
 */
app.get('/reload', auth, function(req, res) {
  // Read song data from save file
  fs.readdir(PATH, function(err, items) {
    res.json(items);

    // For each song
    for (var i=0; i<items.length; i++) {
      // If it is an MP3
      if (path.extname(items[i]) === '.mp3') {
        // Save the song data to the database
        var songpath = PATH+items[i];
        mongocon.saveSong(songpath, items[i], function(){console.log("callback fn");});
      };
    }
  });
});

/**
 * @function app.get('/save')
 * @param {HTTP Request} req - HTTP request
 *                             Contains a path to the song file to be saved
 * @param {HTTP Response} rs - HTTP Response
 * 
 * Endpoint to save a file to the server
 */
app.get('/save', auth, function(req, res){
  mongocon.saveSong('test.mp3');
});

/**
 * @function app.get('/loggedin')
 * 
 * Endpoint to let the client know whether or not the user is logged in.
 * This is not directly displayed to the user.
 */
app.get('/loggedin', function(req, res) {
  res.send(req.isAuthenticated() ? req.user : '0');
});

/**
 * @function app.get('/login')
 * 
 * Endpoint for the user to login.
 */
app.post('/login', passport.authenticate('local'), function(req, res) {
  res.send(req.user);
});

/**
 * @function app.get('/logout')
 * 
 * Endpoint for the user to logout.
 */
app.post('/logout', function(req, res){
  req.logOut();
  res.send(200);
});

/**
 * @function app.get('/views/:v')
 * 
 * Views endpoint. Display the v object within the req body.
 */
app.get('/views/:v', function(req, res) {
  res.render(req.params.v);
});

/**
 * @function app.get('/')
 * 
 * Default endpoint. Display the home layout.
 */
app.get('/', function(req, res) {
  res.render('layout', {
    title: 'PlayMyWay',
    env: process.env.NODE_ENV
  });

});

// Set the server port to either the environment default, or 8080
var port = process.env.PORT || 8080;

// Start the server
http.listen(port, function(){
  console.log("Listening on port " + port);
});
