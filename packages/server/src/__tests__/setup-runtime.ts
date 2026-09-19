import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const previousDataDir = process.env.MDQ_DATA_DIR;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-jest-data-"));
process.env.MDQ_DATA_DIR = testDataDir;

afterAll(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) {
    delete process.env.MDQ_DATA_DIR;
  } else {
    process.env.MDQ_DATA_DIR = previousDataDir;
  }
});
