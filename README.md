# Unified Help Scraper Bot

Unified Help Scraper is a Slack bot that scrapes Hack Club help tickets from Slack support channels and saves them on a database for use in the Unified Help platform. The scraper checks for new tickets and automatically indexes tickets into a database. It determines assignees, resolvers, response times, first responders, assignment times, and can even index user groups and channels and add users as helpers for programs. The scraper can also index old tickets with a backlog command.

Unified Help Scraper works best with the Unified Help platform: https://github.com/normalperson543/unified-help

## How to use

The scraper receives events the Slack API using HTTP over port 4000 (/slack).

The scraper provides an authenticated Express-based API so that Unified Help can interact with the scraper. You are not meant to directly interact with this API, it is only meant to be exposed with the Unified Help app, and changes can be breaking. The following is a list of the possible API routes (you must pass a x-api-token in headers matching the .env API token to see these routes):

`GET /` - Returns `{online: "true"}` to indicate the scraper is responding correctly

`POST /api/backlog/[program ID]/start` - Starts a backlog task for a program. You can send a backlogTo and backlogFrom in the request body which indicate the Slack timestamps from where to start and end backlogging. Also requires an actorId in the request body corresponding to the Unified Help user ID that executed this task.

`POST /api/index-user-group/[program ID]` - Indexes a Slack user group to assign them to a program. Accepts a usergroupId in the request body that indicates the Slack user group ID that will be indexed into the program.

`GET /api/backlog/[program ID]/status` - Gets the current status of a backlog task for a specific program.

`GET /api/backlog` - Gets the entire status of the backlogger. Currently unused.

`POST /api/backlog/[program ID]/stop` - Stops any backlog tasks for a program. Requires an actorId in the request body that indicates the Unified Help user ID that executed this command.

## Getting started

This requires a Slack bot to be installed into your workspace. Go to https://api.slack.com/apps and create a new app with the `manifest.json` file provided at the Unified Help repository: https://github.com/normalperson543/unified-help/blob/main/manifest.json

Git clone this repo. Next, rename .example.env to .env, and complete the environment variables. (ideally you should link the postgres database to the same database that Unified Help is on)

Make sure your SCRAPER_API_KEY variable is the same on Unified Help and the scraper bot.

## Development

Install deps:

`npm install`

Build the Prisma schema:

`npx prisma generate`

If you haven't already, push the schema to your database:

`npx prisma migrate dev`

Then run the development server:

`npm run dev`

The scraper is now running and will automatically index tickets. You can also open http://localhost:4000 to test the API (make sure to pass the API key as x-api-key in the header).

## Deployment

Install deps:

`npm install`

Build the Prisma schema:

`npx prisma generate`

Push the schema to your database:

`npx prisma migrate deploy`

Build:

`npm run build`

Run the server:

`node dist/main.js`

The built version of the scraper is now running. You can also open http://localhost:4000 to test the API (make sure to pass the API key as x-api-key in the header).

## Building Docker image

You can simply run `docker build .` to build the Unified Help scraper image.
