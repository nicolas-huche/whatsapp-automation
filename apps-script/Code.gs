/**
 * PedidoBot — Google Apps Script da planilha de pedidos.
 *
 * Como instalar:
 * 1. Abra a planilha do Google Sheets usada pelo backend.
 * 2. Extensoes > Apps Script.
 * 3. Cole este arquivo em Code.gs.
 * 4. Configuracoes do projeto > Propriedades do script:
 *    - BACKEND_URL       https://seu-backend-publico.exemplo.com
 *    - BACKEND_TOKEN     (opcional) token que vai no header X-Webhook-Token
 *    - SHEET_NAME        (opcional) nome da aba. Padrao: Pedidos
 * 5. Gatilhos (icone de relogio) > Adicionar gatilho:
 *    - Funcao: onEditInstalled
 *    - Implantacao: Head
 *    - Fonte: Planilha
 *    - Tipo: On edit
 *    - Autorize o script com sua conta.
 *
 * Como usar:
 * - O backend cria uma linha por item do pedido com order_id compartilhado.
 * - Preencha a coluna unit_price de cada item.
 * - Marque a coluna status de QUALQUER linha do pedido como PRONTO.
 * - O script agrupa todos os itens com aquele order_id, calcula total,
 *   manda pro backend e marca as linhas como ENVIADO.
 */

const COLUMNS = {
  timestamp: 1,
  order_id: 2,
  customer_phone: 3,
  customer_name: 4,
  product: 5,
  quantity: 6,
  unit: 7,
  unit_price: 8,
  total: 9,
  status: 10
};

const HEADER_ROW = 1;

function sheetName_() {
  return PropertiesService.getScriptProperties().getProperty('SHEET_NAME') || 'Pedidos';
}

function backendUrl_() {
  const url = PropertiesService.getScriptProperties().getProperty('BACKEND_URL');
  if (!url) throw new Error('BACKEND_URL nao configurada nas propriedades do script.');
  return url.replace(/\/+$/, '');
}

function authHeaders_() {
  const token = PropertiesService.getScriptProperties().getProperty('BACKEND_TOKEN');
  return token ? { 'X-Webhook-Token': token } : {};
}

function onEditInstalled(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (sheet.getName() !== sheetName_()) return;

  if (e.range.getColumn() !== COLUMNS.status) return;
  if (e.range.getRow() <= HEADER_ROW) return;

  const value = String(e.value || '').trim().toUpperCase();
  if (value !== 'PRONTO') return;

  const orderId = String(sheet.getRange(e.range.getRow(), COLUMNS.order_id).getValue() || '').trim();
  if (!orderId) {
    SpreadsheetApp.getUi().alert('Linha sem order_id. Preencha antes de marcar PRONTO.');
    return;
  }

  finalizeOrder_(sheet, orderId);
}

function finalizeOrder_(sheet, orderId) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) return;

  const data = sheet.getRange(HEADER_ROW + 1, 1, lastRow - HEADER_ROW, COLUMNS.status).getValues();
  const matching = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[COLUMNS.order_id - 1] || '').trim() === orderId) {
      matching.push({ rowIndex: HEADER_ROW + 1 + i, row });
    }
  }

  if (!matching.length) return;

  const first = matching[0].row;
  const items = matching.map(({ row }) => ({
    product_name: String(row[COLUMNS.product - 1] || '').trim(),
    quantity: Number(row[COLUMNS.quantity - 1]),
    unit: String(row[COLUMNS.unit - 1] || 'un').trim(),
    unit_price: Number(row[COLUMNS.unit_price - 1])
  }));

  for (const item of items) {
    if (!item.product_name) {
      throw new Error(`Pedido ${orderId} tem item sem nome de produto.`);
    }
    if (!item.quantity || isNaN(item.quantity) || item.quantity <= 0) {
      throw new Error(`Pedido ${orderId}: quantidade invalida em ${item.product_name}.`);
    }
    if (!item.unit_price || isNaN(item.unit_price) || item.unit_price <= 0) {
      throw new Error(`Pedido ${orderId}: preenche o preco de ${item.product_name}.`);
    }
  }

  const total = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);

  for (let i = 0; i < matching.length; i++) {
    const item = items[i];
    sheet.getRange(matching[i].rowIndex, COLUMNS.total)
      .setValue(Number((item.quantity * item.unit_price).toFixed(2)));
  }

  const payload = {
    order_id: orderId,
    customer_phone: String(first[COLUMNS.customer_phone - 1] || '').trim(),
    customer_name: String(first[COLUMNS.customer_name - 1] || '').trim(),
    items: items,
    total: Number(total.toFixed(2))
  };

  const response = UrlFetchApp.fetch(`${backendUrl_()}/order/finalize`, {
    method: 'post',
    contentType: 'application/json',
    headers: authHeaders_(),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText();

  if (status < 200 || status >= 300) {
    throw new Error(`Backend retornou ${status}: ${body}`);
  }

  for (const { rowIndex } of matching) {
    sheet.getRange(rowIndex, COLUMNS.status).setValue('ENVIADO');
  }
}

/**
 * Utilitario manual: roda uma vez para criar a aba e o cabecalho
 * com a mesma ordem de colunas que o backend escreve.
 */
function setupSheet() {
  const ss = SpreadsheetApp.getActive();
  const name = sheetName_();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);

  const headers = [
    'timestamp',
    'order_id',
    'customer_phone',
    'customer_name',
    'product',
    'quantity',
    'unit',
    'unit_price',
    'total',
    'status'
  ];

  sheet.getRange(HEADER_ROW, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(HEADER_ROW, 1, 1, headers.length).setFontWeight('bold');

  const statusRange = sheet.getRange(HEADER_ROW + 1, COLUMNS.status, sheet.getMaxRows() - HEADER_ROW, 1);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['', 'PRONTO', 'ENVIADO'], true)
    .setAllowInvalid(true)
    .build();
  statusRange.setDataValidation(rule);
}

/**
 * Utilitario manual: forca finalizacao de um order_id (util se onEdit falhou).
 * Abre o editor do Apps Script, escolhe o ID no prompt e roda.
 */
function finalizeOrderManually() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Finalizar pedido', 'Informe o order_id:', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const orderId = response.getResponseText().trim();
  if (!orderId) return;

  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName_());
  if (!sheet) {
    ui.alert(`Aba ${sheetName_()} nao existe.`);
    return;
  }

  finalizeOrder_(sheet, orderId);
  ui.alert(`Pedido ${orderId} enviado ao backend.`);
}
