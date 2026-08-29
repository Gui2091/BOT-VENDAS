const products = [
  {
    id: 'vip_ouro',
    name: 'VIP Ouro',
    price: 61.49,
    euro: '9,99€',
    renewal: 'A cada 3 meses',
    description: '• 600% a mais de ganhos de XP\n• Cargo exclusivo\n• Chat exclusivo\n• Chat especial com acesso direto à equipe de Diretor e Sub Fundador\n• Futuros benefícios exclusivos'
  },
  {
    id: 'acesso_prioritario',
    name: 'Acesso Prioritário',
    price: 73.99,
    euro: '11,99€',
    renewal: 'A cada 3 meses',
    description: '• Prioridade de acesso ao REAL RP\n• Fotos e atualizações do mapa antes dos demais membros\n• Acesso antecipado a novidades e atualizações do projeto'
  },
  {
    id: 'atendimento_rapido',
    name: 'Atendimento Rápido',
    price: 29.99,
    euro: '4,99€',
    renewal: 'A cada 3 meses',
    description: '• Acesso a um canal exclusivo de tickets\n• Prioridade no atendimento da equipe\n• Mais agilidade para dúvidas, problemas e solicitações'
  },
  {
    id: 'combo_ouro_prioritario',
    name: 'VIP Ouro + Acesso Prioritário',
    price: 122.59,
    euro: '19,99€',
    renewal: 'A cada 1 ano',
    description: '• Todos os benefícios do VIP Ouro\n• Todos os benefícios do Acesso Prioritário'
  }
];

function getProduct(id) {
  return products.find((product) => product.id === id);
}

function formatBRL(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

module.exports = { products, getProduct, formatBRL };
