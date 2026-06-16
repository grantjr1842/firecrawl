import {
  judgeChange,
  judgeChangePreprocess,
  parseJudgeText,
  sanitizeMeaningfulChanges,
} from "./judgeChange";
import { logger as winstonLogger } from "../../lib/logger";

const HAS_GEMINI = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const describeIfGemini = HAS_GEMINI ? describe : describe.skip;
const TEST_TIMEOUT = 30000;
const buildLogger = () => winstonLogger.child({ test: "judgeChange" });

describe("judgeChange — no-LLM deterministic behavior", () => {
  describe("judgeChangePreprocess (no-diff branch)", () => {
    it("returns the no-diff default when neither jsonDiff nor markdownDiff.diffText is supplied", () => {
      const out = judgeChangePreprocess({ goal: "anything" });
      expect(out.kind).toBe("no-diff");
      if (out.kind !== "no-diff") return;
      expect(out.result.meaningful).toBe(true);
      expect(out.result.confidence).toBe("low");
      expect(out.result.meaningfulChanges).toEqual([]);
      expect(out.result.reason).toMatch(/no diff/i);
    });

    it("returns no-diff when markdownDiff is present but diffText is undefined", () => {
      const out = judgeChangePreprocess({
        goal: "anything",
        markdownDiff: {},
      });
      expect(out.kind).toBe("no-diff");
    });

    it("returns no-diff when jsonDiff is an empty object", () => {
      const out = judgeChangePreprocess({ goal: "anything", jsonDiff: {} });
      expect(out.kind).toBe("no-diff");
    });
  });

  describe("judgeChangePreprocess (needs-judge branch)", () => {
    it("assembles goal + markdown diff in the user block", () => {
      const out = judgeChangePreprocess({
        goal: "watch the headline",
        markdownDiff: { diffText: "- old\n+ new" },
      });
      expect(out.kind).toBe("needs-judge");
      if (out.kind !== "needs-judge") return;
      expect(out.userBlock).toMatch(/^MONITOR GOAL:\nwatch the headline/);
      expect(out.userBlock).toContain("PAGE DIFF (unified):");
      expect(out.userBlock).toContain("- old\n+ new");
      expect(out.userBlock).not.toContain("EXTRACTION PROMPT");
    });

    it("includes the extraction prompt section when supplied", () => {
      const out = judgeChangePreprocess({
        goal: "watch the price",
        extractionPrompt: "extract the Pro plan price",
        jsonDiff: { price: { previous: "$19", current: "$29" } },
      });
      expect(out.kind).toBe("needs-judge");
      if (out.kind !== "needs-judge") return;
      expect(out.userBlock).toContain("EXTRACTION PROMPT");
      expect(out.userBlock).toContain("extract the Pro plan price");
      expect(out.userBlock).toContain("FIELD DIFFS");
      expect(out.userBlock).toContain('"price"');
    });

    it("trims whitespace around the goal and extraction prompt", () => {
      const out = judgeChangePreprocess({
        goal: "  watch the price  ",
        extractionPrompt: "  extract the price  ",
        markdownDiff: { diffText: "x" },
      });
      expect(out.kind).toBe("needs-judge");
      if (out.kind !== "needs-judge") return;
      expect(out.userBlock).toContain("MONITOR GOAL:\nwatch the price");
      expect(out.userBlock).toContain("extract the price\n");
      expect(out.userBlock).not.toMatch(/  watch the price/);
    });

    it("renders the jsonDiff as pretty-printed JSON in the field-diffs section", () => {
      const out = judgeChangePreprocess({
        goal: "g",
        jsonDiff: { headline: { previous: "a", current: "b" } },
      });
      expect(out.kind).toBe("needs-judge");
      if (out.kind !== "needs-judge") return;
      expect(out.userBlock).toMatch(/"headline": \{[\s\S]*"previous": "a"/);
    });
  });

  describe("parseJudgeText", () => {
    it("extracts a JSON object wrapped in prose", () => {
      const out = parseJudgeText(
        "Sure, here you go:\n" +
          JSON.stringify({
            meaningful: false,
            confidence: "high",
            reason: "noise",
            meaningfulChanges: [],
          }) +
          "\nThanks!",
      );
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.result.meaningful).toBe(false);
      expect(out.result.confidence).toBe("high");
      expect(out.result.reason).toBe("noise");
      expect(out.result.meaningfulChanges).toEqual([]);
    });

    it("falls back to low-confidence meaningful when no JSON object is present", () => {
      const out = parseJudgeText("I have no idea, sorry.");
      expect(out.kind).toBe("unparseable");
      if (out.kind !== "unparseable") return;
      expect(out.textPeek).toBe("I have no idea, sorry.");
      expect(out.result.meaningful).toBe(true);
      expect(out.result.confidence).toBe("low");
      expect(out.result.reason).toMatch(/unparseable/i);
    });

    it("falls back when JSON is malformed", () => {
      const out = parseJudgeText('{"meaningful": tru,');
      expect(out.kind).toBe("json-error");
      if (out.kind !== "json-error") return;
      expect(out.result.meaningful).toBe(true);
      expect(out.result.confidence).toBe("low");
      expect(out.result.reason).toMatch(/not valid JSON/i);
      expect(out.error.length).toBeGreaterThan(0);
    });

    it("defaults meaningful to true when the field is missing", () => {
      const out = parseJudgeText(
        JSON.stringify({ confidence: "medium", reason: "r" }),
      );
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.result.meaningful).toBe(true);
    });

    it("defaults confidence to low when the field is missing or invalid", () => {
      const ok = parseJudgeText(
        JSON.stringify({ meaningful: false, reason: "r" }),
      );
      expect(ok.kind).toBe("ok");
      if (ok.kind !== "ok") return;
      expect(ok.result.confidence).toBe("low");

      const bad = parseJudgeText(
        JSON.stringify({ meaningful: true, confidence: "yolo", reason: "r" }),
      );
      expect(bad.kind).toBe("ok");
      if (bad.kind !== "ok") return;
      expect(bad.result.confidence).toBe("low");
    });

    it("falls back to 'No reason provided.' when the reason is empty/missing", () => {
      const out = parseJudgeText(
        JSON.stringify({ meaningful: true, reason: "" }),
      );
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.result.reason).toBe("No reason provided.");
    });

    it("drops meaningfulChanges when meaningful is false", () => {
      const out = parseJudgeText(
        JSON.stringify({
          meaningful: false,
          confidence: "high",
          reason: "no",
          meaningfulChanges: [
            { type: "added", before: null, after: "x", reason: "r" },
          ],
        }),
      );
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.result.meaningfulChanges).toEqual([]);
    });

    it("keeps well-formed meaningfulChanges and drops malformed ones", () => {
      const out = parseJudgeText(
        JSON.stringify({
          meaningful: true,
          confidence: "medium",
          reason: "yes",
          meaningfulChanges: [
            {
              type: "added",
              before: null,
              after: "new item",
              reason: "matches goal",
            },
            {
              type: "removed",
              before: "old item",
              after: null,
              reason: "gone",
            },
            { type: "changed", before: "a", after: "b", reason: "updated" },
            { type: "modified", before: "a", after: "b", reason: "x" },
            { type: "added", before: "x", after: "y", reason: "x" },
            { type: "added", before: null, after: "x" },
            "not-an-object",
          ],
        }),
      );
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.result.meaningfulChanges).toEqual([
        {
          type: "added",
          before: null,
          after: "new item",
          reason: "matches goal",
        },
        { type: "removed", before: "old item", after: null, reason: "gone" },
        { type: "changed", before: "a", after: "b", reason: "updated" },
      ]);
    });
  });

  describe("sanitizeMeaningfulChanges", () => {
    it("returns [] when meaningful is false even if input is an array", () => {
      expect(
        sanitizeMeaningfulChanges(
          [{ type: "added", before: null, after: "x", reason: "r" }],
          false,
        ),
      ).toEqual([]);
    });

    it("returns [] when input is not an array", () => {
      expect(sanitizeMeaningfulChanges(null, true)).toEqual([]);
      expect(sanitizeMeaningfulChanges("nope", true)).toEqual([]);
      expect(sanitizeMeaningfulChanges({ not: "an array" }, true)).toEqual([]);
    });
  });

  describe("judgeChange (no-diff fast path — no LLM call)", () => {
    it("returns the no-diff default without calling Gemini", async () => {
      const result = await judgeChange({
        logger: buildLogger(),
        goal: "anything",
      });
      expect(result.meaningful).toBe(true);
      expect(result.confidence).toBe("low");
      expect(result.meaningfulChanges).toEqual([]);
      expect(result.reason).toMatch(/no diff/i);
    });
  });
});

describeIfGemini("judgeChange — live Gemini", () => {
  it(
    "classifies whitespace-only field change as noise",
    async () => {
      const result = await judgeChange({
        logger: buildLogger(),
        goal: "Track the page heading verbatim",
        jsonDiff: {
          headline: {
            previous: "Power AI agents with clean web data",
            current: "Power AI agents with  clean web data",
          },
        },
      });
      expect(result.meaningful).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "named-field rule: sub-1% price change is meaningful when goal names 'price'",
    async () => {
      const result = await judgeChange({
        logger: buildLogger(),
        goal: "Track the Pro tier price. Tell me about ANY price change.",
        jsonDiff: {
          pro_price: { previous: "$19.00", current: "$19.01" },
        },
      });
      expect(result.meaningful).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "named-field rule does NOT apply to unmentioned fields",
    async () => {
      const result = await judgeChange({
        logger: buildLogger(),
        goal: "Track the Pro tier price.",
        jsonDiff: {
          view_count: { previous: "12402", current: "12418" },
        },
      });
      expect(result.meaningful).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "markdown: new list item matching the goal is meaningful",
    async () => {
      const result = await judgeChange({
        logger: buildLogger(),
        goal: "tell me when a new MacBook is announced",
        markdownDiff: {
          diffText:
            "@@ -1,4 +1,5 @@\n # MacBook lineup\n+- MacBook Air M4 — NEW\n - MacBook Air M2\n - MacBook Pro M3\n \n-Updated 2026-05-19T18:42:00Z\n+Updated 2026-05-19T18:43:01Z",
        },
      });
      expect(result.meaningful).toBe(true);
      expect(result.reason.toLowerCase()).toMatch(/macbook|m4|new/);
    },
    TEST_TIMEOUT,
  );
});
