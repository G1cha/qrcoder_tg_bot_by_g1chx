import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { MAX_ORDERS, parseOrders } from "../src/orders.js";
import worker from "../src/index.js";

test("ignores empty lines and trims repeated whitespace when enabled", () => {
  assert.deepEqual(parseOrders("\n  A   123  \n\nB456\n", true), ["A 123", "B456"]);
});

test("preserves spaces when cleanup is disabled", () => {
  assert.deepEqual(parseOrders(" A  123 \nB456", false), [" A  123 ", "B456"]);
});

test("accepts up to 100 orders", () => {
  const input = Array.from({ length: MAX_ORDERS }, (_, index) => `order-${index + 1}`).join("\n");
  assert.equal(parseOrders(input, true).length, MAX_ORDERS);
});

test("rejects lists over 100 orders", () => {
  const input = Array.from({ length: MAX_ORDERS + 1 }, (_, index) => `order-${index + 1}`).join("\n");
  assert.throws(() => parseOrders(input, true), /не более 100/);
});

test("rejects empty and excessively long orders", () => {
  assert.throws(() => parseOrders(" \n\n", true), /хотя бы один номер/);
  assert.throws(() => parseOrders("x".repeat(257), true), /длиннее 256 символов/);
});

test("QR library generates a PNG image", async () => {
  const png = await QRCode.toBuffer("123456789", { width: 128, margin: 2 });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("webhook settings enqueue separate QR jobs and queue sends PNG photos", async (t) => {
  const store = new Map();
  const jobs = [];
  const telegramCalls = [];
  const env = {
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "test-secret",
    BOT_STATE: {
      async get(key, type) {
        const value = store.get(key);
        return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
      },
      async put(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      }
    },
    QR_JOBS: {
      async sendBatch(batch) {
        jobs.push(...batch.map((entry) => entry.body));
      }
    }
  };

  t.mock.method(globalThis, "fetch", async (url, init) => {
    telegramCalls.push({ url: String(url), init });
    return Response.json({ ok: true, result: {} });
  });

  async function sendUpdate(update) {
    const response = await worker.fetch(
      new Request("https://bot.test/telegram-webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "test-secret"
        },
        body: JSON.stringify(update)
      }),
      env
    );
    assert.equal(response.status, 200);
  }

  await sendUpdate({ message: { chat: { id: 42 }, text: "/start" } });
  await sendUpdate({
    callback_query: {
      id: "trim",
      data: "toggle_trim",
      message: { message_id: 1, chat: { id: 42 } }
    }
  });
  await sendUpdate({
    callback_query: {
      id: "damaged",
      data: "toggle_damaged",
      message: { message_id: 1, chat: { id: 42 } }
    }
  });
  await sendUpdate({
    callback_query: {
      id: "create",
      data: "create",
      message: { message_id: 1, chat: { id: 42 } }
    }
  });
  await sendUpdate({
    message: { chat: { id: 42 }, text: "  order  1  \norder-2" }
  });

  assert.deepEqual(jobs, [
    { chatId: 42, orderNumber: "  order  1  ", damaged: true },
    { chatId: 42, orderNumber: "order-2", damaged: true }
  ]);

  let acknowledged = false;
  await worker.queue(
    {
      messages: [
        {
          body: jobs[0],
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            assert.fail("successful send should not be retried");
          }
        }
      ]
    },
    env
  );

  const photoCall = telegramCalls.find(({ url }) => url.endsWith("/sendPhoto"));
  assert.ok(photoCall);
  const form = photoCall.init.body;
  const png = new Uint8Array(await form.get("photo").arrayBuffer());
  assert.equal(Buffer.from(png.subarray(0, 8)).toString("hex"), "89504e470d0a1a0a");
  assert.equal(form.get("caption"), "Заказ:   order  1  \n⚠️ ПОВРЕЖДЁННЫЙ ЗАКАЗ");
  assert.equal(acknowledged, true);
});
