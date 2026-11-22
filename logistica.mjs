
const contractMoney = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:4});
const logisticsDate = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
const daysTo = date => Math.round((Date.parse(date)-Date.parse(logisticsDate()))/86400000);
const dateLabel = date => date ? date.split('-').reverse().join('/') : '—';
const qty = value => Math.round(value*1e6)/1e6;
const logisticsText = text => String(text??'').trim();

function itemBalances(contract,item) {
  let requested=0,accepted=0;
  for(const order of contract.ordens) {
    const line=order.itens.find(entry=>entry.id===item.id);
    if(!line) continue;
    accepted+=line.remessas.reduce((sum,entry)=>sum+entry.aceita,0);
    requested+=line.quantidade-(line.cancelada??0);
  }
  return {requested:qty(requested),accepted:qty(accepted),available:qty(item.quantidade-requested),pending:qty(requested-accepted)};
}

function deliveryItems(contract,kind) {
  return contract.ordens.flatMap(order=>order.itens.flatMap(line=>{
    const accepted=line.remessas.reduce((sum,shipment)=>sum+shipment.aceita,0);
    const delivered=line.remessas.reduce((sum,shipment)=>sum+shipment.entregue,0);
    const awaiting=line.remessas.filter(shipment=>!shipment.conferida).reduce((sum,shipment)=>sum+shipment.entregue,0);
    const amount=kind==='itens_pendentes'?qty(line.quantidade-(line.cancelada??0)-accepted-awaiting):kind==='itens_entregues'?qty(delivered):qty(accepted);
    const item=contract.itens.find(entry=>entry.id===line.id);
    return amount>0&&item?[{order,item,amount}]:[];
  }));
}

function orderSummary(order) {
  let pending=0,accepted=0,awaiting=0;
  for(const item of order.itens) {
    const results=item.remessas.reduce((sum,r)=>sum+r.aceita,0);
    accepted+=results;
    pending+=item.quantidade-(item.cancelada??0)-results;
    awaiting+=item.remessas.filter(r=>!r.conferida).length;
  }
  return {pending:qty(pending),accepted:qty(accepted),awaiting};
}

const orderStages=['Ordem recebida','Em preparação','Em trânsito'];
const requestsOpen = request => !['Formalizada','Indeferida'].includes(request.situacao);
const contractDue = contract => contract.fim||contract.fim_arp;
const logisticsDefaults={contrato:[60,30,15,7,0],ordem:[7,3,1,0],saldo:[20,10,0]};
export function contractAlerts(contract) {
  if(contract.encerramento) return [];
  const rules=contract.alertas??logisticsDefaults;
  const alerts=[];
  for(const [name,date] of [['Contrato',contract.fim],['Ata',contract.fim_arp]]) {
    if(!date) continue;
    const days=daysTo(date);
    if(days<0 || rules.contrato.some(limit=>days<=limit)) alerts.push({kind:'vigencia',text:name+(days<0?' vencido em '+dateLabel(date):' vence em '+days+' dia(s)')});
  }
  for(const order of contract.ordens) {
    const totals=orderSummary(order);
    if(!totals.pending) continue;
    const days=daysTo(order.prazo);
    if(days<0 || rules.ordem.some(limit=>days<=limit)) alerts.push({kind:'entrega',late:days<0,text:order.numero+(days<0?' em atraso':' vence em '+days+' dia(s)')});
    if(totals.awaiting) alerts.push({kind:'aceite',text:order.numero+' aguarda conferência de '+totals.awaiting+' remessa(s)'});
  }
  for(const item of contract.itens) {
    const {available}=itemBalances(contract,item);
    if(rules.saldo.some(limit=>100*available/item.quantidade<=limit)) alerts.push({kind:'saldo',text:item.nome+' · saldo '+available});
  }
  for(const request of contract.solicitacoes.filter(requestsOpen)) {
    if(request.retorno && daysTo(request.retorno)<=0) alerts.push({kind:'solicitacao',text:request.tipo+' · acompanhar em '+dateLabel(request.retorno)});
  }
  return alerts;
}

const logisticsMenu=[
 ['todos','Todos'],['vigencia','Vigência'],['atraso','Atrasadas'],['entrega','Prazos de entrega'],
 ['itens_pendentes','Itens a entregar'],['itens_entregues','Itens com entrega registrada'],['itens_aceitos','Itens com aceite'],
 ['aceite','Aguardando aceite'],['saldo','Saldo baixo'],['solicitacao','Solicitações abertas'],['encerrado','Encerrados']
];

export function logisticsWorkspace(view, ctx) {
  const {client,group,canWrite,panel,action,edit,escape,table,notice,processes,initialContract,encodePdf,pdfBytes,saveQuoteFile}=ctx;
  const canEdit=!!client&&canWrite;
  if(!client) { panel(view,'<p>Conecte uma empresa para abrir a Logística.</p>'); return; }
  const root=panel(view,'<h2>Ordens de fornecimento e contratos</h2>');
  const controls=document.createElement('div');
  controls.className='line';
  root.append(controls);
  const result=document.createElement('div');
  root.append(result);
  let records=[],filter='todos',search='',selected=initialContract??null;
  function selectField(label,options,change) {
    const wrapper=document.createElement('label');
    const field=document.createElement('select');
    wrapper.append(label,field);
    for(const [value,name] of options) field.add(new Option(name,value));
    field.onchange=()=>change(field.value);
    controls.append(wrapper);
  }
  selectField('Situação',logisticsMenu,value=>{filter=value;list();});
  const query=document.createElement('input');
  query.type='search'; query.placeholder='Número, órgão ou responsável'; query.setAttribute('aria-label','Buscar contrato');
  query.oninput=()=>{search=query.value.toLowerCase();list();}; controls.append(query);
  if(canEdit) action('Cadastrar contrato ou ata',()=>newContract(),controls,true);
  const refresh=async ()=>{
    const request=client.from('contratos_logistica').select('id,grupo_id,edital_id,versao,dados').order('atualizado_em',{ascending:false});
    const {data,error}=await request.eq('grupo_id',group);
    if(error) throw error;
    if(!root.isConnected) return;
    records=data;
    if(selected && records.some(row=>row.id===selected)) details(records.find(row=>row.id===selected));
    else list();
  };
  const saved=()=>refresh().catch(error=>notice(error.message));
  async function save(row,datos,description) {
    const dados={...datos,acao:description};
    if(row) {
      const {data,error}=await client.from('contratos_logistica').update({dados,versao:row.versao+1}).eq('id',row.id).eq('versao',row.versao).select('id').maybeSingle();
      if(error) throw error;
      if(!data) throw new Error('O contrato foi alterado em outra sessão. Feche e atualize a página.');
    } else {
      const {data,error}=await client.from('contratos_logistica').insert({grupo_id:group,edital_id:datos.edital_id||null,dados}).select('id').single();
      if(error) throw error;
      selected=data.id;
    }
  }
  function form(title,fields,handler,optional=[]) {
    edit(title,fields,handler,{onSaved:saved,decorate:form=>{
      for(const name of optional) form.elements[name].required=false;
    }});
  }
  function newContract() {
    form('Cadastrar contrato ou ata',[
      ['edital_id','Processo finalizado','select','manual',[['manual','Cadastro manual'],...processes.map(row=>[row.id,row.label])]],
      ['numero','Número do instrumento','text'],['orgao','Órgão comprador (cadastro manual)','text'],
      ['responsavel','Responsável','text'],['fim','Fim da vigência do contrato','date'],
      ['arp','Número da ata','text'],['fim_arp','Fim da vigência da ata','date'],['documento','Referência ou link do documento','text']
    ],async values=>{
      const process=processes.find(row=>row.id===values.edital_id);
      if(!values.fim&&!values.fim_arp) throw new Error('Informe a vigência do contrato ou da ata.');
      if(!process&&!logisticsText(values.orgao)) throw new Error('Informe o órgão comprador.');
      await save(null,{...values,edital_id:process?.id??null,orgao:process?.orgao??values.orgao,
        itens:process?.itens??[],ordens:[],solicitacoes:[],historico:[],alertas:logisticsDefaults},'Instrumento cadastrado');
    },['orgao','fim','arp','fim_arp','documento']);
  }
  function list() {
    selected=null;
    result.replaceChildren();
    const scope=records;
    const count=key=>scope.filter(({dados:c})=>matches(c,key)).length;
    const delivery=panel(result,'<h3>Entregas por item</h3>');
    const cards=document.createElement('div');cards.className='line';delivery.append(cards);
    for(const [key,label] of [['itens_pendentes','Itens a entregar'],['itens_entregues','Itens com entrega registrada'],['itens_aceitos','Itens com aceite']]) {
      action(label+' · '+scope.reduce((total,{dados})=>total+deliveryItems(dados,key).length,0),()=>{
        filter=key;controls.querySelector('select').value=key;list();
      },cards);
    }
    if(scope.length) {
      const metrics=panel(result,'<h3>Pendências da carteira</h3>');
      for(const [key,label] of logisticsMenu.slice(1).filter(([key])=>!key.startsWith('itens_'))) action(label+' · '+count(key),()=>{
        filter=key;controls.querySelector('select').value=key;list();
      },metrics);
    }
    const rows=scope.filter(({dados:c})=>matches(c,filter)&&[c.numero,c.arp,c.orgao,c.responsavel].join(' ').toLowerCase().includes(search));
    if(!rows.length) panel(result,'<p>Nenhum contrato corresponde à consulta.</p>');
    for(const row of rows) {
      const c=row.dados;
      const alerts=contractAlerts(c);
      const card=panel(result,'<h3>'+escape(c.numero)+' · '+escape(c.orgao)+'</h3><p>'+
        escape([c.responsavel,c.encerramento?'Encerrado':'Vigência '+dateLabel(contractDue(c))].filter(Boolean).join(' · '))+'</p>');
      if(alerts.length) card.append(alerts.map(alert=>alert.text).join(' · '));
      if(c.solicitacoes.some(requestsOpen)) card.append(' · '+c.solicitacoes.filter(requestsOpen).length+' solicitação(ões) aberta(s)');
      if(filter.startsWith('itens_')) {
        const lines=table(card,['Ordem','Item','Quantidade','Prazo']);
        for(const entry of deliveryItems(c,filter)) cells(lines,[entry.order.numero,entry.item.nome,entry.amount,dateLabel(entry.order.prazo)]);
      }
      action('Abrir contrato',()=>details(row),card);
    }
  }
  function matches(c,key) {
    if(key==='todos') return true;
    if(key.startsWith('itens_')) return deliveryItems(c,key).length>0;
    if(key==='encerrado') return !!c.encerramento;
    if(key==='solicitacao') return !c.encerramento&&c.solicitacoes.some(requestsOpen);
    return contractAlerts(c).some(alert=>key==='atraso'?alert.late:alert.kind===key);
  }
  function details(row) {
    selected=row.id;
    result.replaceChildren();
    const c=row.dados;
    const writable=canEdit&&!c.encerramento;
    const card=panel(result,'<h3>'+escape(c.numero)+' · '+escape(c.orgao)+'</h3><p>'+
      'Responsável: '+escape(c.responsavel)+' · Contrato '+dateLabel(c.fim)+' · Ata '+escape(c.arp||'—')+' '+dateLabel(c.fim_arp)+'</p>');
    if(c.documento) panel(card,'<p>Documento de origem: '+escape(c.documento)+'</p>');
    action('Voltar à carteira',list,card);
    const alerts=contractAlerts(c);
    if(alerts.length) panel(card,'<ul>'+alerts.map(alert=>'<li>'+escape(alert.text)+'</li>').join('')+'</ul>');
    if(writable) action('Configurar alertas',()=>configure(row),card);
    const items=panel(result,'<h3>Saldo por item</h3>');
    if(!contractDue(c)) panel(card,'<p>Vigência pendente. Complete o cadastro para emitir ordens.</p>');
    if(writable) action('Completar dados do contrato ou ata',()=>form('Dados do contrato ou ata',[
      ['numero','Número do instrumento','text',c.numero],['arp','Número da ata','text',c.arp],
      ['fim','Fim da vigência do contrato','date',c.fim],['fim_arp','Fim da vigência da ata','date',c.fim_arp],
      ['responsavel','Responsável','text',c.responsavel]
    ],values=>{
      if(!values.fim&&!values.fim_arp) throw new Error('Informe pelo menos uma data de vigência.');
      return save(row,{...c,...values},'Identificação e vigência atualizadas');
    },['arp','fim','fim_arp']),card);
    if(writable) action('Adicionar item',()=>addItem(row),items);
    const saldo=table(items,['Item','Contratado','Solicitado','Aceito','Pendente','Disponível','Preço vigente']);
    for(const item of c.itens) {
      const totals=itemBalances(c,item);
      cells(saldo,[item.nome,item.quantidade,totals.requested,totals.accepted,totals.pending,totals.available,contractMoney.format(priceAt(c,item,logisticsDate()))]);
    }
    const orders=panel(result,'<h3>Ordens de fornecimento</h3>');
    if(writable&&c.itens.length&&daysTo(contractDue(c))>=0) action('Nova ordem',()=>newOrder(row),orders,true);
    for(const order of c.ordens) showOrder(orders,row,order,writable);
    const documents=panel(result,'<h3>Solicitações do órgão e documentos recebidos</h3>');
    if(writable) action('Anexar solicitação em PDF',()=>form('Anexar solicitação do órgão',[
      ['nome','Identificação do documento ou número da ordem','text'],['arquivo','Documento em PDF','file']
    ],async ({nome,arquivo})=>{
      const pdf=await encodePdf(arquivo);
      const {error}=await client.from('logistica_solicitacao_arquivos').insert({contrato_id:row.id,nome:nome.trim(),pdf});
      if(error) throw error;
    }),documents,true);
    const docList=panel(documents,'<p>Carregando documentos…</p>');
    client.from('logistica_solicitacao_arquivos').select('id,nome,criado_em').eq('contrato_id',row.id).order('criado_em',{ascending:false}).then(({data,error})=>{
      if(!docList.isConnected) return;
      docList.replaceChildren();
      if(error||!data.length) {docList.textContent=error?'Não foi possível carregar os documentos.':'Nenhuma solicitação anexada.';return;}
      for(const doc of data) action('Baixar '+doc.nome,async ()=>{
        const {data,error}=await client.from('logistica_solicitacao_arquivos').select('pdf').eq('id',doc.id).eq('contrato_id',row.id).single();
        if(error) throw error;
        saveQuoteFile(new Blob([pdfBytes(data.pdf)],{type:'application/pdf'}),doc.nome.replace(/\.pdf$/i,'')+'.pdf');
      },docList);
    });
    const requests=panel(result,'<h3>Solicitações e alterações</h3>');
    if(writable) {
      if(c.itens.length) action('Solicitar revisão de preço',()=>newRequest(row,'Revisão de preço'),requests);
      action('Solicitar aditivo',()=>newRequest(row,'Aditivo'),requests);
      action('Preparar encerramento',()=>closeContract(row),requests);
    }
    for(const request of c.solicitacoes) {
      const r=panel(requests,'<strong>'+escape(request.tipo+' · '+request.situacao)+'</strong><p>'+escape(request.motivo)+'</p>');
      const previous=request.anterior;
      const labels=[previous!=null?'Anterior: '+previous:null,request.proposto?'Solicitado: '+request.proposto:null,
        request.aprovado?'Formalizado: '+request.aprovado:null,request.protocolo?'Protocolo: '+request.protocolo:null,
        request.efeito?'Efeito: '+dateLabel(request.efeito):null,request.retorno?'Acompanhar em '+dateLabel(request.retorno):null,
        request.documento?'Documento: '+request.documento:null,request.comprovantes?'Comprovantes: '+request.comprovantes:null];
      const line=document.createElement('p'); line.textContent=labels.filter(Boolean).join(' · '); r.append(line);
      if(request.tipo==='Revisão de preço') {
        const item=c.itens.find(item=>item.id===request.item);
        const impact=(Number(request.proposto)-Number(request.anterior))*itemBalances(c,item).available;
        const change=(Number(request.custo_atual)-Number(request.custo_anterior))/Number(request.custo_anterior)*100;
        const margin=(Number(request.anterior)-Number(request.custo_atual))/Number(request.anterior)*100;
        const text=document.createElement('p');
        text.textContent='Custo: '+contractMoney.format(request.custo_anterior)+' → '+contractMoney.format(request.custo_atual)+
          ' · Variação '+change.toFixed(2)+'% · Margem atual '+margin.toFixed(2)+'% · Impacto estimado no saldo: '+contractMoney.format(impact);
        r.append(text);
      }
      action('Baixar rascunho',()=>{
        const content=[request.tipo,c.numero+' · '+c.orgao,request.motivo,line.textContent].join(String.fromCharCode(10,10));
        const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));
        const link=document.createElement('a'); link.href=url; link.download='solicitacao-contratual.txt';link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      },r);
      if(writable&&requestsOpen(request)) action('Acompanhar solicitação',()=>progressRequest(row,request),r);
    }
    if(c.encerramento) panel(result,'<h3>Encerrado em '+dateLabel(c.encerramento.data)+'</h3><p>'+escape(c.encerramento.motivo+' · '+c.encerramento.documento)+'</p>');
    const history=panel(result,'<h3>Histórico do contrato</h3>');
    for(const event of [...c.historico].reverse()) panel(history,'<p>'+escape(new Date(event.em).toLocaleString('pt-BR')+' · '+event.acao+' · '+event.usuario)+'</p>');
  }
  function cells(element,values) {
    const tr=element.insertRow();
    for(const value of values) tr.insertCell().textContent=value;
    return tr;
  }
  function positive(value) {
    const number=Number(value);
    if(!Number.isFinite(number)||number<=0) throw new Error('Informe um número maior que zero.');
    return number;
  }
  function configure(row) {
    const rules=row.dados.alertas??logisticsDefaults;
    form('Limites dos alertas',[
      ['contrato','Vigência · dias antes (separados por vírgula)','text',rules.contrato.join(', ')],
      ['ordem','Entrega · dias antes (separados por vírgula)','text',rules.ordem.join(', ')],
      ['saldo','Saldo · percentuais (separados por vírgula)','text',rules.saldo.join(', ')]
    ],values=>{
      const alertas=Object.fromEntries(Object.entries(values).map(([key,value])=>{
        const limits=value.split(',').map(entry=>entry.trim());
        if(limits.some(entry=>!/^\d+$/.test(entry)||Number(entry)>(key==='saldo'?100:365))) throw new Error('Informe limites inteiros válidos.');
        return [key,[...new Set(limits.map(Number))]];
      }));
      return save(row,{...row.dados,alertas},'Limites de alerta alterados');
    });
  }
  function addItem(row) {
    form('Adicionar item contratado',[
      ['nome','Item e unidade','text'],['quantidade','Quantidade contratada','number'],['preco','Preço unitário','number']
    ],values=>save(row,{...row.dados,itens:[...row.dados.itens,{...values,id:crypto.randomUUID(),
      quantidade:positive(values.quantidade),preco:positive(values.preco)}]},'Item contratado incluído'));
  }
  function priceAt(c,item,date) {
    const changes=c.solicitacoes.filter(r=>r.tipo==='Revisão de preço'&&r.item===item.id&&r.situacao==='Formalizada'&&r.efeito<=date);
    return Number(changes.sort((a,b)=>a.efeito.localeCompare(b.efeito)).at(-1)?.aprovado??item.preco);
  }
  function newOrder(row) {
    const c=row.dados;
    form('Registrar ordem de fornecimento',[
      ['numero','Número da ordem','text'],['prazo','Prazo de entrega','date'],['endereco','Endereço de entrega','text'],
      ['responsavel','Responsável','text',c.responsavel],['documento','Referência ou link da ordem','text'],
      ...c.itens.map((item,i)=>['item'+i,item.nome+' · disponível '+itemBalances(c,item).available,'number',0])
    ],values=>{
      if(!c.fim&&!c.fim_arp || daysTo(contractDue(c))<0) throw new Error('Instrumento fora da vigência.');
      if(c.ordens.some(order=>order.numero.toLowerCase()===values.numero.trim().toLowerCase())) throw new Error('Essa ordem já foi registrada.');
      const itens=c.itens.flatMap((item,i)=>{
        const quantidade=Number(values['item'+i]);
        if(!quantidade) return [];
        if(quantidade>itemBalances(c,item).available||quantidade<0) throw new Error('Quantidade fora do saldo de '+item.nome);
        return [{id:item.id,quantidade,preco:priceAt(c,item,logisticsDate()),remessas:[]}];
      });
      if(!itens.length) throw new Error('Informe a quantidade de pelo menos um item.');
      const {numero,prazo,endereco,responsavel,documento}=values;
      return save(row,{...c,ordens:[...c.ordens,{id:crypto.randomUUID(),numero:numero.trim(),prazo,endereco,responsavel,documento,
        etapa:orderStages[0],itens}]},'Ordem '+numero+' registrada');
    },['documento']);
  }
  function changeOrder(row,order,updated,description) {
    return save(row,{...row.dados,ordens:row.dados.ordens.map(entry=>entry.id===order.id?updated:entry)},description);
  }
  function showOrder(parent,row,order,writable) {
    const totals=orderSummary(order);
    const status=!totals.pending?'Concluída':totals.awaiting?'Entregue, aguardando aceite':totals.accepted?'Entrega parcial':order.etapa;
    const card=panel(parent,'<strong>'+escape(order.numero)+' · '+escape(status)+'</strong><p>'+escape(order.responsavel+' · '+order.endereco+' · prazo '+dateLabel(order.prazo))+'</p>');
    if(order.documento||order.rastreio||order.transportador||order.saida) {
      const line=document.createElement('p'); line.textContent=[order.documento,order.transportador,order.rastreio,dateLabel(order.saida)].filter(Boolean).join(' · '); card.append(line);
    }
    if(writable&&totals.pending) action('Atualizar preparação ou trânsito',()=>form('Atualizar expedição',[
      ['etapa','Etapa','select',order.etapa,orderStages],['saida','Data da saída','date',order.saida],
      ['transportador','Transportador','text',order.transportador],['rastreio','Rastreio','text',order.rastreio]
    ],values=>changeOrder(row,order,{...order,...values},'Expedição da ordem '+order.numero+' atualizada'),['saida','transportador','rastreio']),card);
    for(const line of order.itens) {
      const item=row.dados.itens.find(entry=>entry.id===line.id);
      const reserved=qty(line.remessas.reduce((sum,r)=>sum+(r.conferida?r.aceita:r.entregue),0));
      const missing=qty(line.quantidade-(line.cancelada??0)-reserved);
      const sub=panel(card,'<p>'+escape(item.nome)+' · solicitado '+line.quantidade+' · '+contractMoney.format(line.preco)+' por unidade</p>');
      for(const shipment of line.remessas) {
        const entry=panel(sub,'<p>'+escape(dateLabel(shipment.data)+' · Entregue '+shipment.entregue+
          (shipment.conferida?' · Aceita '+shipment.aceita:' · Aguardando aceite')+' · '+shipment.recebedor+
          ' · NF '+(shipment.nota||'—')+' · '+(shipment.comprovante||'—'))+'</p>');
        if(writable&&!shipment.conferida) action('Confirmar aceite',()=>form('Conferir remessa',[
          ['aceita','Quantidade aceita','number',shipment.entregue],['observacao','Observação da conferência','text']
        ],values=>{
          const aceita=Number(values.aceita);
          if(aceita<0||aceita>shipment.entregue) throw new Error('A quantidade aceita precisa estar entre zero e a entregue.');
          if(aceita<shipment.entregue&&!logisticsText(values.observacao)) throw new Error('Informe o motivo da recusa.');
          return updateLine(row,order,line,{...line,remessas:line.remessas.map(r=>r.id===shipment.id?
            {...r,aceita,conferida:true,observacao:values.observacao}:r)},'Aceite registrado na ordem '+order.numero);
        },['observacao']),entry);
      }
      if(writable&&missing>0) {
        action('Registrar entrega',()=>form('Registrar remessa',[
          ['entregue','Quantidade entregue','number'],['data','Data da entrega','date',logisticsDate()],
          ['recebedor','Quem recebeu','text'],['nota','Nota fiscal','text'],['comprovante','Referência ou link do comprovante','text']
        ],values=>{
          const entregue=positive(values.entregue);
          if(entregue>missing) throw new Error('A quantidade excede a pendência do item.');
          return updateLine(row,order,line,{...line,remessas:[...line.remessas,{...values,entregue,aceita:0,conferida:false,id:crypto.randomUUID()}]},'Remessa registrada na ordem '+order.numero);
        },['nota','comprovante']),sub);
        action('Cancelar quantidade pendente',()=>form('Cancelar quantidade pendente',[
          ['quantidade','Quantidade a liberar para saldo','number',missing],['motivo','Motivo','text']
        ],values=>{
          const quantidade=positive(values.quantidade);
          if(quantidade>missing) throw new Error('A quantidade excede a pendência.');
          return updateLine(row,order,line,{...line,cancelada:qty((line.cancelada??0)+quantidade)},'Cancelamento de '+quantidade+' na ordem '+order.numero+' · '+values.motivo);
        }),sub);
      }
    }
  }
  function updateLine(row,order,line,updated,description) {
    return changeOrder(row,order,{...order,itens:order.itens.map(entry=>entry.id===line.id?updated:entry)},description);
  }
  function newRequest(row,tipo) {
    const c=row.dados;
    const price=tipo==='Revisão de preço';
    form(tipo,[
      ...(!price?[['objeto','Objeto','select','Prazo',['Prazo','Quantidade','Outra condição']]]:[]),
      ...(c.itens.length?[['item','Item (obrigatório para preço ou quantidade)','select',c.itens[0].id,c.itens.map(item=>[item.id,item.nome])]]:[]),
      ['proposto',price?'Preço unitário solicitado':'Nova data, quantidade total ou condição','text'],
      ...(price?[['custo_anterior','Custo anterior','number'],['custo_atual','Custo atual','number']]:[]),
      ['motivo','Justificativa','textarea'],['comprovantes','Referências ou links dos comprovantes','textarea'],
      ['responsavel','Responsável','text',c.responsavel],['retorno','Próximo acompanhamento','date']
    ],values=>{
      const item=c.itens.find(entry=>entry.id===values.item);
      const anterior=price?priceAt(c,item,logisticsDate()):values.objeto==='Prazo'?contractDue(c):values.objeto==='Quantidade'?item?.quantidade:null;
      if(price) { positive(values.proposto); positive(values.custo_anterior); positive(values.custo_atual); }
      if(values.objeto==='Quantidade'&&!item) throw new Error('Cadastre o item antes de solicitar alteração de quantidade.');
      return save(row,{...c,solicitacoes:[...c.solicitacoes,{...values,tipo,anterior,id:crypto.randomUUID(),situacao:'Rascunho'}]},tipo+' em rascunho');
    },['comprovantes','retorno']);
  }
  function progressRequest(row,request) {
    const transitions={'Rascunho':['Rascunho','Protocolada'],'Protocolada':['Protocolada','Em análise','Formalizada','Indeferida'],
      'Em análise':['Em análise','Formalizada','Indeferida']};
    form('Acompanhar '+request.tipo,[
      ['situacao','Situação','select',request.situacao,transitions[request.situacao]],
      ['protocolo','Protocolo','text',request.protocolo],['retorno','Próximo acompanhamento','date',request.retorno],
      ['aprovado','Valor, data, quantidade ou condição formalizada','text',request.aprovado],
      ['efeito','Data de efeito','date',request.efeito],['documento','Referência do documento ou resposta','text',request.documento]
    ],values=>{
      const c=row.dados;
      const updated={...c,solicitacoes:c.solicitacoes.map(entry=>entry.id===request.id?{...entry,...values}:entry)};
      if(values.situacao!=='Rascunho'&&!logisticsText(values.protocolo)) throw new Error('Informe o protocolo para acompanhar a solicitação.');
      if(values.situacao==='Formalizada') {
        if(!logisticsText(values.documento)||!values.efeito||!logisticsText(values.aprovado)) throw new Error('Informe o documento, a data de efeito e a alteração formalizada.');
        if(request.tipo==='Revisão de preço') positive(values.aprovado);
        else {
          if(values.efeito>logisticsDate()) throw new Error('Registre a formalização do aditivo na data de efeito ou depois.');
          if(request.objeto==='Prazo') {
            if(!/^\d{4}-\d{2}-\d{2}$/.test(values.aprovado)||!Number.isFinite(Date.parse(values.aprovado))) throw new Error('Informe a vigência no formato AAAA-MM-DD.');
            updated[c.fim?'fim':'fim_arp']=values.aprovado;
          }
          if(request.objeto==='Quantidade') {
            const item=c.itens.find(entry=>entry.id===request.item);
            const quantidade=positive(values.aprovado);
            if(quantidade<itemBalances(c,item).requested) throw new Error('A quantidade não pode ficar abaixo do que já foi solicitado.');
            updated.itens=c.itens.map(entry=>entry.id===item.id?{...entry,quantidade}:entry);
          }
        }
      }
      return save(row,updated,request.tipo+' · '+values.situacao);
    },['protocolo','retorno','aprovado','efeito','documento']);
  }
  function closeContract(row) {
    const c=row.dados;
    const pending=c.ordens.filter(order=>orderSummary(order).pending>0).length;
    const requests=c.solicitacoes.filter(requestsOpen).length;
    const awaiting=c.ordens.reduce((sum,order)=>sum+orderSummary(order).awaiting,0);
    form('Encerramento · '+pending+' ordem(ns) pendente(s) · '+awaiting+' aceite(s) · '+requests+' solicitação(ões)',[
      ['data','Data do encerramento','date',logisticsDate()],['motivo','Motivo','textarea'],
      ['documento','Referência do documento','text'],['pendencias','Destino das pendências e valores a receber','textarea']
    ],values=>{
      if(values.data>logisticsDate()) throw new Error('A data de encerramento ainda não chegou.');
      return save(row,{...c,encerramento:{...values,saldos:c.itens.map(item=>({id:item.id,...itemBalances(c,item)}))}},'Encerramento registrado');
    });
  }
  result.textContent='Carregando contratos…';
  saved();
}
