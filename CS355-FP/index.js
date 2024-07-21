const fs = require("fs");
const http = require("http");
const url = require("url");
const https = require("https");
const crypto = require("crypto");
const querystring = require("querystring");

const [{client_id, client_secret, redirect_uris, response_type, scope, grant_type}, {key} ] = require("./auth/credentials.json");


const port = 3000;

const all_sessions = [];
server = http.createServer();

server.on("listening", listen_handler);
server.listen(port);
function listen_handler(){
    console.log(`Now Listening on Port ${port}`);
}

server.on("request", request_handler);
function request_handler(req, res){
    console.log(`New Request from ${req.socket.remoteAddress} for ${req.url}`);
    if (req.url === "/"){
        const form = fs.createReadStream("html/index.html");
        res.writeHead(200, {"Content-Type": "text/html"});
        form.pipe(res);
    }
    else if (req.url.startsWith("/search_nba")) {
        const user_input = new URL(req.url, `https://${req.headers.host}`).searchParams;
        const team = user_input.get("team");
        
		if(user_input == null){
			not_found(res);
            return;
		}
        const state = crypto.randomBytes(20).toString("hex");
        all_sessions.push({team, state});
        redirect_to_google(state, res);
    } 
    else if (req.url.startsWith("/receive_code")) {
        const user_input = new URL(req.url, `https://${req.headers.host}`).searchParams;
        const code = user_input.get("code");
        const state = user_input.get("state");
       
        let session = all_sessions.find((session) => session.state === state);
        
        if (code === undefined || state === undefined || session === undefined) {
            not_found(res);
            return;
        }
        const team = session.team;
        console.log(code);
        send_access_token_request(code, team, res);
    } 
    else{
        not_found(res);
    }
}

function not_found(res) {
    res.writeHead(404, {"Content-Type": "text/html"});
    res.end(`<h1>404 Not Found</h1>`);
}

function redirect_to_google(state, res) {
    const authorization_endpoint = "https://accounts.google.com/o/oauth2/v2/auth";
    const redirect_uri = redirect_uris[0];
    let uri = new URLSearchParams({client_id, redirect_uri, response_type, scope, state}).toString();
    
    res.writeHead(302, {Location: `${authorization_endpoint}?${uri}`}).end();
}

function send_access_token_request(code, user_input, res) {
    const token_endpoint = "https://oauth2.googleapis.com/token";
    const redirect_uri = redirect_uris[0];
    let post_data = new URLSearchParams({code, client_id, client_secret, grant_type, redirect_uri}).toString();
    let options = {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
    };
    https.request(token_endpoint, options, 
        (token_stream) => process_stream(token_stream, receive_access_token, user_input, res)
    ).end(post_data);
}

function process_stream(stream, callback, ...args) {
    let body = "";
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => callback(body, ...args));
}

function receive_access_token(body, user_input, res) {
    console.log(body);
    const {access_token} = JSON.parse(body);
    console.log(access_token);
    get_team_information(user_input, access_token, res);
}

function get_team_information(user_input, access_token, res) {
    const teams_endpoint = "https://api.sportsdata.io/v3/nba/scores/json/AllTeams?key=4b48b17745b3483cace8ceb5caeb37f7";
    const sportsdata_request = https.request(teams_endpoint, {method: "GET"});
    sportsdata_request.on("response", (stream) => process_stream(stream, receive_team_id, user_input, access_token, res));
    sportsdata_request.end();
}

function receive_team_id(body, user_input, access_token, res) {
    const teams_object = JSON.parse(body);
    let team_id;
    teams_object.map((team) => {
        if (team.Name.toUpperCase() == user_input.toUpperCase()) team_id = team.TeamID;
    });
    if (team_id == null ) {
        not_found(res);
        return;
    }
    else{ 
        get_team_schedule(team_id, user_input, access_token, res);
    }
}

function get_team_schedule(team_id, user_input, access_token, res) {
    const games_endpoint = "https://api.sportsdata.io/v3/nba/scores/json/Games/{2024}?key=4b48b17745b3483cace8ceb5caeb37f7";
    const sportsdata_request = https.request(games_endpoint, {method: "GET"});
    sportsdata_request.on("response", (stream) => process_stream(stream, receive_team_schedule, team_id, user_input, access_token, res));
    sportsdata_request.end();
}

function receive_team_schedule(body, team_id, user_input, access_token, res) {
    const schedule_object = JSON.parse(body);
    let teams_schedule = [];

    schedule_object.forEach((game) => 
    { 
        if(game.AwayTeamID == team_id || game.HomeTeamID == team_id){
            teams_schedule.push(game);
        }
    });
    
    create_schedule(teams_schedule, user_input, access_token, res);
}





function create_schedule(teams_schedule, user_input, access_token, res) {
    console.log(access_token);
    const event_endpoint = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    const options = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${access_token}`,
        }
    };

    let event_added_count = 0;
    teams_schedule.forEach(create_event);
    function create_event(game) {
        const post_data = JSON.stringify({summary: `${game.AwayTeam} vs. ${game.HomeTeam}`, description: "NBA Basketball Game", end: {dateTime: game.DateTime, timeZone:"America/New_York"}, start: {dateTime: game.DateTime, timeZone:"America/New_York"},});
        
        https.request(event_endpoint, options, 
            (event_stream) => process_stream(event_stream, receive_event_response, res)
        ).end(post_data);
    }

    function receive_event_response(body, res) {
        
        event_added_count++;
        if (event_added_count === teams_schedule.length) {
            res.writeHead(302, {Location: `https://calendar.google.com/calendar/u/0/r`}).end();
        }
    }
}