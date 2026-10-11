// Ask the bot questions from the terminal, without WhatsApp:
//   npm run ask -- "what's due this week?"
//   npm run ask            (interactive)
import readline from "node:readline/promises";
import { answerQuestion } from "./agent.js";

const question = process.argv.slice(2).join(" ");
if (question) {
  console.log(await answerQuestion(question, { askedBy: "terminal" }));
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    const q = (await rl.question("\nAsk> ")).trim();
    if (!q || q === "exit") break;
    console.log(await answerQuestion(q, { askedBy: "terminal" }));
  }
  rl.close();
}
