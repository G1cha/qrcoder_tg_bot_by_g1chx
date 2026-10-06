import { create as createQr } from "qrcode/lib/core/qrcode.js";
import { MAX_ORDERS, parseOrders } from "./orders.js";

const PREFERENCES_TTL = 60 * 60 * 24 * 30;
const AWAITING_TTL = 60 * 15;
const PHOTO_INTERVAL_MS = 1100;

function preferencesKey(chatId) {
  return `prefs:${chatId}`;
}

function awaitingKey(chatId) {
  return `awaiting:${chatId}`;
}

async function getPreferences(env, chatId) {
  return (await env.BOT_STATE.get(preferencesKey(chatId), "json")) ?? {
    trimSpaces: true,
    damaged: false
  };
}

async function savePreferences(env, chatId, preferences) {
  await env.BOT_STATE.put(preferencesKey(chatId), JSON.stringify(preferences), {
    expirationTtl: PREFERENCES_TTL
  });
}

function keyboard(preferences) {
  return {
    inline_keyboard: [
      [{ text: "Создать QR-коды", callback_data: "create" }],
      [
        {
          text: `Удалять лишние пробелы: ${preferences.trimSpaces ? "ВКЛ" : "ВЫКЛ"}`,
          callback_data: "toggle_trim"
        }
      ],
      [
        {
          text: `Повреждённый заказ: ${preferences.damaged ? "ВКЛ" : "ВЫКЛ"}`,
          callback_data: "toggle_damaged"
        }
      ]
    ]
  };
}

async function telegramRequest(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description ?? response.statusText}`);
  }

  return result.result;
}

async function sendMessage(env, chatId, text, replyMarkup) {
  return telegramRequest(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function sendMenu(env, chatId, text) {
  const preferences = await getPreferences(env, chatId);
  await sendMessage(env, chatId, text, keyboard(preferences));
}

async function handleCallback(env, callback) {
  const chatId = callback.message?.chat?.id;
  if (!chatId) {
    await telegramRequest(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Не удалось определить чат."
    });
    return;
  }

  const preferences = await getPreferences(env, chatId);

  if (callback.data === "create") {
    await env.BOT_STATE.put(awaitingKey(chatId), "1", { expirationTtl: AWAITING_TTL });
    await telegramRequest(env, "answerCallbackQuery", { callback_query_id: callback.id });
    await sendMessage(
      env,
      chatId,
      `Пришлите номера заказов одним сообщением, каждый с новой строки. Можно отправить до ${MAX_ORDERS} номеров.`,
      {
        inline_keyboard: [[{ text: "Отмена", callback_data: "cancel" }]]
      }
    );
    return;
  }

  if (callback.data === "cancel") {
    await env.BOT_STATE.delete(awaitingKey(chatId));
    await telegramRequest(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Создание QR-кодов отменено."
    });
    await sendMenu(env, chatId, "Выберите действие.");
    return;
  }

  if (callback.data === "toggle_trim") {
    preferences.trimSpaces = !preferences.trimSpaces;
  } else if (callback.data === "toggle_damaged") {
    preferences.damaged = !preferences.damaged;
  } else {
    await telegramRequest(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Неизвестная команда."
    });
    return;
  }

  await savePreferences(env, chatId, preferences);
  await telegramRequest(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "Настройка сохранена."
  });
  await telegramRequest(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: callback.message.message_id,
    reply_markup: keyboard(preferences)
  });
}

async function handleMessage(env, message) {
  const chatId = message.chat.id;
  const text = message.text ?? "";

  if (text === "/start" || text === "/help") {
    await env.BOT_STATE.delete(awaitingKey(chatId));
    await sendMenu(
      env,
      chatId,
      "Привет! Я создаю QR-коды заказов и отправляю каждый код отдельной картинкой.\n\nНастройте переключатели и нажмите «Создать QR-коды»."
    );
    return;
  }

  if (text.startsWith("/")) {
    await sendMenu(env, chatId, "Используйте кнопку «Создать QR-коды» или команду /start.");
    return;
  }

  const isAwaitingOrders = await env.BOT_STATE.get(awaitingKey(chatId));
  if (!isAwaitingOrders) {
    await sendMenu(env, chatId, "Чтобы создать коды, нажмите «Создать QR-коды».");
    return;
  }

  const preferences = await getPreferences(env, chatId);
  let orders;
  try {
    orders = parseOrders(text, preferences.trimSpaces);
  } catch (error) {
    await sendMessage(env, chatId, error.message);
    return;
  }

  await env.BOT_STATE.delete(awaitingKey(chatId));
  try {
    await env.QR_JOBS.sendBatch(
      orders.map((orderNumber) => ({
        body: {
          chatId,
          orderNumber,
          damaged: preferences.damaged
        }
      }))
    );
  } catch (error) {
    console.error("Failed to enqueue QR jobs:", error);
    await env.BOT_STATE.put(awaitingKey(chatId), "1", { expirationTtl: AWAITING_TTL });
    await sendMessage(env, chatId, "Не удалось поставить QR-коды в очередь. Попробуйте отправить список ещё раз.");
    return;
  }

  await sendMessage(
    env,
    chatId,
    `Принято: ${orders.length} ${orders.length === 1 ? "заказ" : "заказов"}. Отправляю каждый QR-код отдельной фотографией.`
  );
}

async function handleUpdate(env, update) {
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }

  if (update.message?.chat && typeof update.message.text === "string") {
    await handleMessage(env, update.message);
  }
}

function photoCaption(job) {
  const caption = `Заказ: ${job.orderNumber}`;
  return job.damaged ? `${caption}\n⚠️ ПОВРЕЖДЁННЫЙ ЗАКАЗ` : caption;
}

function writeUint32(target, value) {
  target.push(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  );
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = [];
  writeUint32(chunk, data.length);
  chunk.push(...typeBytes, ...data);
  writeUint32(chunk, crc32([...typeBytes, ...data]));
  return chunk;
}

function concatenateBytes(parts) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export async function createQrPng(text) {
  const imageSize = 512;
  const margin = 4;
  const { modules } = createQr(text, { errorCorrectionLevel: "M" });
  const moduleScale = imageSize / (modules.size + margin * 2);
  const pixels = new Uint8Array((imageSize + 1) * imageSize);

  for (let y = 0; y < imageSize; y += 1) {
    const rowOffset = y * (imageSize + 1);
    pixels[rowOffset] = 0;
    const moduleY = Math.floor(y / moduleScale) - margin;
    for (let x = 0; x < imageSize; x += 1) {
      const moduleX = Math.floor(x / moduleScale) - margin;
      const isDark =
        moduleX >= 0 &&
        moduleY >= 0 &&
        moduleX < modules.size &&
        moduleY < modules.size &&
        modules.get(moduleY, moduleX);
      pixels[rowOffset + x + 1] = isDark ? 0 : 0xff;
    }
  }

  const header = [];
  writeUint32(header, imageSize);
  writeUint32(header, imageSize);
  header.push(8, 0, 0, 0, 0);

  const compressedPixels = new Uint8Array(
    await new Response(
      new Blob([pixels]).stream().pipeThrough(new CompressionStream("deflate"))
    ).arrayBuffer()
  );
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  return concatenateBytes([
    signature,
    new Uint8Array(pngChunk("IHDR", header)),
    new Uint8Array(pngChunk("IDAT", compressedPixels)),
    new Uint8Array(pngChunk("IEND", []))
  ]);
}

async function sendQrPhoto(env, job) {
  const png = await createQrPng(job.orderNumber);
  const form = new FormData();
  form.set("chat_id", String(job.chatId));
  form.set("caption", photoCaption(job));
  form.set("photo", new Blob([png], { type: "image/png" }), "order-qr.png");

  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form
  });
  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(`Telegram sendPhoto returned HTTP ${response.status} with a non-JSON response`);
  }

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram sendPhoto failed (HTTP ${response.status}, error ${result.error_code ?? "unknown"}): ${result.description ?? response.statusText}`
    );
  }
}

async function handleQueue(batch, env) {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      await new Promise((resolve) => setTimeout(resolve, PHOTO_INTERVAL_MS));
      await sendQrPhoto(env, job);
      message.ack();
    } catch (error) {
      console.error("Failed to send QR photo:", error);
      if (message.attempts >= 5) {
        try {
          await sendMessage(
            env,
            job.chatId,
            `Не удалось отправить QR-код заказа «${job.orderNumber}» после нескольких попыток. Причина: ${error.message}`
          );
        } catch (notificationError) {
          console.error("Failed to notify user about QR delivery:", notificationError);
        }
        message.ack();
      } else {
        message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/telegram-webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
      await handleUpdate(env, update);
    } catch (error) {
      console.error("Failed to process Telegram update:", error);
      return Response.json({ ok: false }, { status: 500 });
    }

    return Response.json({ ok: true });
  },

  async queue(batch, env) {
    await handleQueue(batch, env);
  }
};
