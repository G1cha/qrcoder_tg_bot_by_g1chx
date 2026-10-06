export const MAX_ORDERS = 100;
export const MAX_ORDER_LENGTH = 256;

export function parseOrders(text, trimSpaces) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error("Пришлите хотя бы один номер заказа, каждый с новой строки.");
  }

  if (lines.length > MAX_ORDERS) {
    throw new Error(`За один раз можно отправить не более ${MAX_ORDERS} заказов. Разделите список на несколько сообщений.`);
  }

  const orders = lines.map((line) => (trimSpaces ? line.trim().replace(/\s+/g, " ") : line));
  const tooLongIndex = orders.findIndex((order) => order.length > MAX_ORDER_LENGTH);

  if (tooLongIndex !== -1) {
    throw new Error(`Номер в строке ${tooLongIndex + 1} длиннее ${MAX_ORDER_LENGTH} символов.`);
  }

  return orders;
}
