import { describe, expect, it } from "vitest";
import { unzip as read } from "../../testing/unzip.js";
import { ZipWriter } from "./ZipWriter.js";

describe("zip writer", () => {
  it("writes entries an unzip tool reads back, compressed when it helps", () => {
    const zip = new ZipWriter();
    const csv = Buffer.from(`id,name\n${"1,Kwame Mensah\n".repeat(500)}`);
    zip.add("tables/drivers.csv", csv);
    zip.add("files/a b?.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const archive = zip.finish();
    const files = read(archive);
    expect([...files.keys()]).toEqual(["tables/drivers.csv", "files/a_b_.png"]);
    expect(files.get("tables/drivers.csv")).toEqual(csv);
    expect(archive.length).toBeLessThan(csv.length);
  });
});
