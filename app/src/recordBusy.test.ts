import { describe, expect, it } from "vitest";
import { convertsWhileRecording, recordBlock } from "./recordBusy";

const idle = { converting: false, saving: false, asking: false, liveOn: false };

describe("recordBlock", () => {
  it("lets a new recording start while a recording is converting", () => {
    expect(recordBlock({ ...idle, converting: true })).toBeNull();
  });
  it("blocks only when live captions are on during a conversion", () => {
    expect(recordBlock({ ...idle, converting: true, liveOn: true })).toBe("live");
    expect(recordBlock({ ...idle, liveOn: true })).toBeNull();
  });
  it("still blocks while asking about or saving the last recording", () => {
    expect(recordBlock({ ...idle, asking: true })).toBe("asking");
    expect(recordBlock({ ...idle, saving: true, converting: true })).toBe("saving");
  });
});

describe("convertsWhileRecording", () => {
  it("keeps converting during a recording without live captions", () => {
    expect(convertsWhileRecording(true, false)).toBe(true);
    expect(convertsWhileRecording(true, true)).toBe(false);
    expect(convertsWhileRecording(false, true)).toBe(true);
  });
});
