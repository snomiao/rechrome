import { expect, test } from "bun:test";
import { reportedDownloads } from "./serve.ts";

test("downloads count only from the CLI's own ### Events section, in its output dir", () => {
  const cli = '### Result\nok\n### Events\n- Downloading file a.csv ...\n- Downloaded file a.csv to ".playwright-cli/download-a.csv"\n';
  expect(reportedDownloads(cli)).toEqual([{ name: "a.csv", rel: ".playwright-cli/download-a.csv" }]);
  // Page text elsewhere (console, snapshot, eval result) that looks like the line is ignored.
  expect(reportedDownloads('### Result\n- Downloaded file x to ".playwright-cli/x"\n')).toEqual([]);
  expect(reportedDownloads('- Downloaded file x to ".playwright-cli/x"\n')).toEqual([]);
  // In ### Events, but not in the CLI's output dir.
  expect(reportedDownloads('### Events\n- Downloaded file x to "profiles/qa/secret.txt"\n')).toEqual([]);
  // A later section ends the Events block.
  expect(reportedDownloads('### Events\n- New console entries: c.log\n### Snapshot\n- Downloaded file x to ".playwright-cli/x"\n')).toEqual([]);
});
