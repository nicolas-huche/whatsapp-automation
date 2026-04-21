export const catalog = [
  {
    id: 1,
    name: 'Tomate',
    aliases: ['tomate', 'tomates'],
    default_unit: 'kg',
    prices: { kg: 8.9 },
    sales_mode: 'bulk',
    inference_hint: 'Vendido a granel. Quantidade sem unidade deve ser interpretada como kg.'
  },
  {
    id: 2,
    name: 'Cebola',
    aliases: ['cebola', 'cebolas'],
    default_unit: 'kg',
    prices: { kg: 5.9 },
    sales_mode: 'bulk',
    inference_hint: 'Vendida a granel. Quantidade sem unidade deve ser interpretada como kg.'
  },
  {
    id: 3,
    name: 'Alface',
    aliases: ['alface', 'alfaces'],
    default_unit: 'unidade',
    prices: { unidade: 3.5 },
    sales_mode: 'head',
    inference_hint: 'Vendida por cabeca. Quantidade sem unidade deve ser interpretada como unidades.'
  },
  {
    id: 4,
    name: 'Limao',
    display_name: 'Limão',
    aliases: ['limao', 'limão', 'limoes', 'limões'],
    default_unit: null,
    prices: { kg: 6.5, unidade: 0.75 },
    sales_mode: 'ambiguous',
    ambiguous_when_unit_missing: true,
    inference_hint: 'Pode ser vendido por kg ou por unidade. Quantidade sem unidade deve ser marcada como ambigua.'
  },
  {
    id: 5,
    name: 'Batata',
    aliases: ['batata', 'batatas', 'batata inglesa'],
    default_unit: 'kg',
    prices: { kg: 4.9 },
    sales_mode: 'bulk',
    inference_hint: 'Vendida a granel. Quantidade sem unidade deve ser interpretada como kg.'
  },
  {
    id: 6,
    name: 'Cenoura',
    aliases: ['cenoura', 'cenouras'],
    default_unit: 'kg',
    prices: { kg: 5.5 },
    sales_mode: 'bulk',
    inference_hint: 'Vendida a granel. Quantidade sem unidade deve ser interpretada como kg.'
  },
  {
    id: 7,
    name: 'Banana',
    aliases: ['banana', 'bananas', 'banana prata', 'banana d agua', 'banana da agua'],
    default_unit: 'kg',
    prices: { kg: 7.25 },
    sales_mode: 'bulk',
    inference_hint: 'Vendida a granel. Quantidade sem unidade deve ser interpretada como kg.'
  },
  {
    id: 8,
    name: 'Maca',
    display_name: 'Maçã',
    aliases: ['maca', 'maçã', 'macas', 'maçãs'],
    default_unit: 'kg',
    prices: { kg: 9.8 },
    sales_mode: 'bulk',
    inference_hint: 'Vendida a granel. Quantidade sem unidade deve ser interpretada como kg.'
  },
  {
    id: 9,
    name: 'Ovos',
    aliases: ['ovo', 'ovos', 'duzia de ovos', 'dúzia de ovos'],
    default_unit: 'duzia',
    prices: { duzia: 12.0, unidade: 1.1 },
    sales_mode: 'pack',
    inference_hint: 'Normalmente vendido por duzia. Se o cliente disser unidade explicitamente, use unidade.'
  },
  {
    id: 10,
    name: 'Coentro',
    aliases: ['coentro', 'molho de coentro', 'maco de coentro', 'maço de coentro'],
    default_unit: 'maco',
    prices: { maco: 2.5 },
    sales_mode: 'bundle',
    inference_hint: 'Vendido por maco. Quantidade sem unidade deve ser interpretada como macos.'
  }
];
