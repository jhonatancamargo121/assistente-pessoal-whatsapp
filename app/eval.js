const { classify } = require('/app/dist/ai/intent.js');
const { precisaConfirmar } = require('/app/dist/core/confirmacao.js');
const casos = [
  ['marcar dentista amanha 15h','criar_tarefa'],
  ['lembra de pagar a conta de luz sexta','criar_tarefa'],
  ['pilates segunda quarta e sexta 7h','criar_rotina'],
  ['academia todo dia 6 da manha','criar_rotina'],
  ['gastei 50 no mercado','registrar_gasto'],
  ['paguei 120 de uber hoje','registrar_gasto'],
  ['recebi 2000 de salario','registrar_entrada'],
  ['qual meu saldo','consultar_saldo'],
  ['o que tenho hoje','listar_hoje'],
  ['conclui o dentista','concluir_tarefa'],
  ['resumo da semana','relatorio_semanal'],
  ['extrato','extrato'],
  ['ajuda','ajuda'],
  ['oi tudo bem?','conversa'],
  ['bom dia','conversa'],
  ['novo lead: Maria 61999998888 interessada no lote 5','criar_lead'],
  ['aulas de danca terca 18h e quinta 12h','conversa'],
  ['quanto e 15% de 200','conversa'],
];
(async()=>{
  let ok=0; const erros=[];
  for(const [txt,esp] of casos){
    await new Promise(s=>setTimeout(s,2500)); const r=await classify(txt);
    const acertou = r.intent===esp;
    if(acertou) ok++; else erros.push({txt,esp,got:r.intent});
  }
  console.log('=== EVAL: '+ok+'/'+casos.length+' ('+Math.round(ok/casos.length*100)+'%) ===');
  for(const e of erros) console.log('  X "'+e.txt+'" esperado='+e.esp+' obteve='+e.got);
  console.log('--- confirmacao exigida? ---');
  for(const t of ['gastei 50 no mercado','recebi 2000 salario','novo lead: Joao 61988887777']){
    const r=await classify(t); console.log('  '+(precisaConfirmar(r)?'SIM':'nao')+' <- '+t);
  }
})();
