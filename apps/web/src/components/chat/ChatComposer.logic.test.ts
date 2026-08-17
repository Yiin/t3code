import { assert, describe, it } from "vite-plus/test";
import { planImagePersistence } from "./ChatComposer.logic";

const image = (id: string, dataUrl: string) => ({
  type: "image" as const,
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 1,
  dataUrl,
});

describe("planImagePersistence", () => {
  it("keeps the existing persisted entry when reading an attachment fails", () => {
    assert.deepEqual(
      planImagePersistence(
        [{ id: "old" }, image("new", "data:new")],
        [image("old", "data:old"), image("new", "data:old-new")],
      ),
      [image("old", "data:old"), image("new", "data:new")],
    );
  });

  it("prunes persisted entries for removed images", () => {
    assert.deepEqual(
      planImagePersistence(
        [image("kept", "data:kept")],
        [image("kept", "data:old"), image("removed", "data:removed")],
      ),
      [image("kept", "data:kept")],
    );
  });
});
