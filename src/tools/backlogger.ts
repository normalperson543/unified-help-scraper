const BACKLOG_TO = 1782122916196969;

// TODO: automate this somehow

import { App } from "@slack/bolt";
import { config } from "dotenv";
import { indexThread } from "./indexer";
import { exit } from "process";

config();

const app = new App({
  token: process.env["SLACK_BOT_TOKEN"]!,
  socketMode: true,
  appToken: process.env["SLACK_APP_TOKEN"]!,
});

(async () => {
  // Start your app
  await app.start();

  const history = await app.client.conversations.history({
    channel: "C07TM4C0AQ5",
    latest: BACKLOG_TO.toString(),
  });
  console.log(history)
  if (!history.messages) return;
  for (let i = 0; i < history.messages.length; i++) {
    console.log(`Indexing ${history.messages[i]?.ts}`);
    await indexThread(
      app.client,
      "b007990a-a14e-4471-8af8-ab251fb8fc1b",
      "C07TM4C0AQ5",
      history.messages[i]?.ts!,
    );
  }
  console.log("Complete.")

  exit();
})();
