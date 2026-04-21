export function buildOrderPrompt(catalog) {
  const catalogForPrompt = catalog.map((product) => ({
    product_id: product.id,
    product_name: product.display_name ?? product.name,
    aliases: product.aliases,
    default_unit: product.default_unit,
    prices: product.prices,
    sales_mode: product.sales_mode,
    ambiguous_when_unit_missing: Boolean(product.ambiguous_when_unit_missing),
    inference_hint: product.inference_hint
  }));

  return `
Voce e um parser de pedidos de hortifruti/mercado recebidos por WhatsApp.
Sua tarefa e transformar texto informal em um pedido JSON estruturado.

Regras obrigatorias:
- Retorne somente JSON valido no formato solicitado pelo schema.
- Identifique todos os itens do pedido.
- Use exclusivamente produtos do catalogo. Nao invente product_id, preco ou produto.
- Quando o produto nao existir no catalogo, mantenha product_id como null, unit_price 0, subtotal 0, confidence baixa e inclua uma ambiguidade pedindo revisao.
- Infira unidade quando o catalogo indicar uma unidade padrao clara.
- Se a unidade foi inferida, marque unit_was_inferred como true.
- Se a unidade nao estiver explicita e o produto puder ser vendido em mais de uma unidade, use confidence baixa e crie uma ambiguidade com opcoes claras.
- "5 tomate" significa 5 kg porque tomate e vendido a granel.
- "2 alface" significa 2 unidades porque alface e vendida por cabeca.
- "2 limao" e ambiguo porque pode significar 2 kg ou 2 unidades.
- Calcule subtotal como quantity * unit_price.
- Calcule total como a soma dos subtotais.
- Preserve original_text exatamente como recebido.
- O idioma das perguntas de ambiguidade deve ser portugues do Brasil.

Catalogo disponivel:
${JSON.stringify(catalogForPrompt, null, 2)}
`.trim();
}
