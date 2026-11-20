import {normalizeDocument, validDocument} from './documentos.mjs';
import {makeZip} from './pacote.mjs';
import {supabaseUrl, supabasePublishableKey} from './config.mjs';

const client = supabaseUrl && supabasePublishableKey
  ? window.supabase.createClient(supabaseUrl, supabasePublishableKey) : null;
const stages = ['Captado','Em análise','Aprovado','Reprovado'];
const modalities = ['Pregão eletrônico','Pregão presencial','Concorrência','Dispensa','Inexigibilidade','Aquisição simplificada · Caixa Escolar','Chamada pública','Obra · Caixa Escolar','Processo análogo','Pesquisa de preços','Concurso','Leilão','Diálogo competitivo'];
const money = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const byId = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const message = text => { byId('notice').textContent = text; };
const tables = ['empresas','editais','itens','documentos'];
const registryTables = ['orgaos_compradores','catalogo','cotacoes','disputas'];
const allTables = [...tables,...registryTables];
const db = Object.fromEntries(allTables.map(table => [table,[]]));
const unavailableRegistries = new Set();
const localKey = 'elementar-licitacoes-demo-v1';
const screens = {
  painel:'Visão geral',orgaos:'Prefeituras / Clientes',catalogo:'Produtos / Serviços',
  cotacoes:'Cotações de Preços',orcamento:'Orçamento',editais:'Captação',
  propostas:'Propostas',documentacao:'Documentação',propostaPronta:'Proposta Pronta',
  disputa:'Disputa',acompanhamento:'Acompanhamento da Licitação',
  finalizados:'Processos Finalizados',logistica:'Logística',financeiro:'Financeiro',
  configuracoes:'Configurações',aplicativo:'Aplicativo',ajuda:'Central de Ajuda'
};
const pendingScreens = {
  orcamento:'Orçamentos para órgãos compradores antes da publicação do edital.',
  disputa:'Acompanhamento de lances e simulação de preços pela margem.',
  acompanhamento:'Negociação após a disputa, emissão de proposta readequada e acompanhamento até a assinatura.',
  finalizados:'Arquivo de ARP, ata da sessão, contratos e documentos do processo.',
  logistica:'Solicitações do órgão, saldo por item e alertas de 30%, 10% e 5%.',
  financeiro:'Análise de custos e solicitação de reajuste ou revisão de preços.',
  aplicativo:'Instalação e acesso ao aplicativo.'
};
let page = 'painel';
let activeEdital;
let group;
let session;
let groups = [];
let master = false;
let clients = [];
let team = [];
let detailMode = null;

function action(label, run, parent, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (primary) button.className = 'primary';
  button.onclick = () => Promise.resolve().then(run).catch(error => message(error.message));
  parent.append(button);
  return button;
}

function edit(title, fields, save, options = {}) {
  const {dialog = byId('editor'), decorate, onSaved = render} = options;
  const form = dialog.querySelector('form');
  dialog.querySelector('h2').textContent = title;
  form.replaceChildren();
  for (const [name,label,type,value,options] of fields) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const field = document.createElement(type === 'select' || type === 'textarea' ? type : 'input');
    field.name = name;
    if (type === 'select') {
      for (const option of options) {
        const [key,text] = Array.isArray(option) ? option : [option,option];
        field.add(new Option(text,key));
      }
    } else {
      if (type !== 'textarea') field.type = type;
      if (type === 'number') { field.step = 'any'; field.min = '0'; }
    }
    field.value = value ?? '';
    field.required = !['sessao','validade','parecer','empresa_id','email','marca','detalhes','observacao','edital_url','local_disputa','edital_pdf','nome_fantasia','logradouro','numero_endereco','complemento','bairro','cep','telefone'].includes(name);
    if (type === 'file' || ['marca_item','fornecedor','observacao_item'].includes(name)) field.required = false;
    if (type === 'file') field.accept = name === 'logo' ? 'image/png,image/jpeg' : '.pdf,application/pdf';
    wrapper.append(field);
    form.append(wrapper);
  }
  const controls = document.createElement('div');
  controls.className = 'line';
  const submit = document.createElement('button');
  submit.textContent = title === 'Acessar sua conta' ? 'Entrar' : 'Salvar';
  submit.type = 'submit';
  submit.className = 'primary';
  controls.append(submit);
  action('Cancelar', () => dialog.close(), controls);
  form.append(controls);
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      message('');
      const result = await save(Object.fromEntries(new FormData(form)));
      dialog.close();
      onSaved(result);
    } catch (error) {
      form.querySelector('[role=alert]')?.remove();
      const alert = document.createElement('p');
      alert.setAttribute('role','alert');
      alert.textContent = error.message;
      form.append(alert);
    } finally { submit.disabled = false; }
  };
  decorate?.(form);
  dialog.showModal();
}

async function load() {
  if (!client) {
    const data = JSON.parse(localStorage.getItem(localKey) || '{}');
    allTables.forEach(table => { db[table] = data[table] ?? []; });
    return;
  }
  if (!group) {
    allTables.forEach(table => { db[table] = []; });
    unavailableRegistries.clear();
    return;
  }
  const responses = await Promise.all(allTables.map(table => client.from(table).select(table === 'editais'
    ? 'id,grupo_id,empresa_id,numero,numero_pregao,orgao,modalidade,sessao,status,parecer,edital_url,local_disputa,edital_pdf_nome,objeto,modo_disputa,etapa_proposta'
    : table==='cotacoes' ? 'id,grupo_id,empresa_id,titulo,fornecedor,email,observacao,etapa,itens,historico,revisao,criado_em,tipo,orgao_id,assinado_em' : '*').eq('grupo_id',group)));
  const missing = new Set();
  responses.forEach(({error},i) => {
    if (!error) return;
    const table = allTables[i];
    if (!registryTables.includes(table) || !['PGRST205','42P01'].includes(error.code)) throw error;
    missing.add(table);
  });
  unavailableRegistries.clear();
  missing.forEach(table => unavailableRegistries.add(table));
  responses.forEach(({data},i) => { db[allTables[i]] = data ?? []; });
}

async function save(table, values, id) {
  if (!client) {
    const records = db[table];
    const index = records.findIndex(record => record.id === id);
    const recordId = index >= 0 ? id : crypto.randomUUID();
    if (index >= 0) records[index] = {...records[index],...values};
    else records.push({...values,id:recordId,...(table==='catalogo' ? {codigo:'CAT-'+recordId} : {})});
    localStorage.setItem(localKey,JSON.stringify(db));
    return recordId;
  }
  const query = client.from(table);
  const request = id ? query.update(values).eq('grupo_id',group).eq('id',id) : query.insert({...values,grupo_id:group});
  const {data,error} = await request.select('id').single();
  if (error) throw error;
  await load();
  return data.id;
}

const groupRole = () => groups.find(item => item.id === group)?.role;
const canWrite = () => !client || ['admin','operador'].includes(groupRole());
const writeAction = (label,run,parent,primary) => { if (canWrite()) action(label,run,parent,primary); };

function companyFields(row = {}) {
  return [
    ['nome','Razão social','text',row.nome],['cnpj','CNPJ completo','text',row.cnpj],
    ['porte','Enquadramento informado','select','MEI',['MEI','MEI Caminhoneiro','ME','EPP','Demais']]
  ];
}

async function saveCompany(values) {
  values.nome = values.nome.trim();
  values.cnpj = normalizeDocument(values.cnpj);
  if (!values.nome) throw new Error('Informe a razão social.');
  if (values.cnpj.length !== 14 || !validDocument(values.cnpj)) throw new Error('Informe um CNPJ válido, incluindo os dois dígitos verificadores.');
  if (db.empresas.some(row => row.cnpj === values.cnpj)) throw new Error('CNPJ já cadastrado neste grupo.');
  await save('empresas',values);
  return db.empresas.find(row=>row.cnpj===values.cnpj);
}

function company() {
  edit('Cadastrar CNPJ participante',companyFields(),saveCompany);
}

function agencyFields(row = {}) {
  return [
    ['cnpj','CNPJ','text',row.cnpj],
    ['nome','Razão social / Nome do órgão','text',row.nome],
    ['nome_fantasia','Nome fantasia','text',row.nome_fantasia],
    ['logradouro','Logradouro','text',row.logradouro],['numero_endereco','Número do endereço','text',row.numero],
    ['complemento','Complemento','text',row.complemento],['bairro','Bairro','text',row.bairro],
    ['cep','CEP','text',row.cep],['municipio','Município','text',row.municipio],
    ['uf','UF','select',row.uf ?? 'MG','AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ')],
    ['email','E-mail institucional','email',row.email],['telefone','Telefone','tel',row.telefone]
  ];
}

async function saveAgency(values,id) {
  for (const key of Object.keys(values)) values[key] = values[key].trim();
  values.cnpj = normalizeDocument(values.cnpj);
  if (values.cnpj.length !== 14 || !validDocument(values.cnpj)) throw new Error('Informe um CNPJ válido.');
  if (!values.nome || !values.municipio) throw new Error('Informe o órgão e o município.');
  if (db.orgaos_compradores.some(entry=>entry.cnpj===values.cnpj && entry.id!==id)) throw new Error('Este CNPJ já está cadastrado.');
  const {numero_endereco,...data} = values;
  await save('orgaos_compradores',{...data,numero:numero_endereco},id);
  return db.orgaos_compradores.find(entry=>entry.cnpj===values.cnpj);
}

function agencyLookup(form) {
  const cnpj = form.elements.namedItem('cnpj');
  const controls = document.createElement('div');
  controls.className = 'line';
  cnpj.closest('label').after(controls);
  const status = document.createElement('span');
  status.setAttribute('role','status');
  const button = action('Consultar CNPJ',async()=>{
    const requested = normalizeDocument(cnpj.value);
    if (requested.length !== 14 || !validDocument(requested)) {
      status.textContent = 'Informe um CNPJ válido antes de consultar.';
      cnpj.focus();
      return;
    }
    button.disabled = true;
    status.textContent = 'Consultando dados públicos do CNPJ…';
    try {
      const response = await fetch('https://brasilapi.com.br/api/cnpj/v1/'+encodeURIComponent(requested),
        {signal:AbortSignal.timeout(12000)});
      if (response.status === 404) throw new Error('CNPJ não encontrado. Confira o número ou preencha manualmente.');
      if (!response.ok) throw new Error('Consulta indisponível. Tente novamente ou preencha manualmente.');
      const data = await response.json();
      if (!form.isConnected || !form.closest('dialog').open) return;
      if (normalizeDocument(cnpj.value) !== requested) {
        status.textContent = 'O CNPJ mudou. Consulte o novo número.';
        return;
      }
      if (normalizeDocument(data.cnpj) !== requested || !data.razao_social) {
        throw new Error('A consulta não retornou um cadastro válido para esse CNPJ.');
      }
      const fields = {
        nome:data.razao_social,nome_fantasia:data.nome_fantasia,
        logradouro:[data.descricao_tipo_de_logradouro,data.logradouro].filter(Boolean).join(' '),
        numero_endereco:data.numero,complemento:data.complemento,bairro:data.bairro,
        cep:data.cep,municipio:data.municipio,uf:data.uf,email:data.email,telefone:data.ddd_telefone_1
      };
      cnpj.value = requested;
      for (const [name,value] of Object.entries(fields)) form.elements.namedItem(name).value = value ?? '';
      status.textContent = 'Dados preenchidos pela BrasilAPI. Revise antes de salvar.';
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' || error instanceof TypeError
        ? 'Consulta indisponível. Tente novamente ou preencha manualmente.' : error.message;
    } finally { button.disabled = false; }
  },controls);
  controls.append(status);
}

const normalizeSearch = value => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{Diacritic}/gu,'');

function registryPicker(form,{name,table,label,placeholder,title,fields,saveRecord,entryLabel,searchText,initial = '',legacy,apply}) {
  const select = form.elements.namedItem(name);
  select.value = initial;
  if (apply) select.onchange = ()=>apply(db[table].find(entry=>entry.id===select.value));

  const controls = document.createElement('div');
  controls.innerHTML = `<label>${label}<input type="search" placeholder="${placeholder}"></label>`;
  select.closest('label').before(controls);
  const search = controls.querySelector('input');
  function populate(selected) {
    const query = normalizeSearch(search.value.trim());
    const document = normalizeDocument(query);
    select.replaceChildren(new Option(placeholder,''));
    if (legacy) select.add(new Option(legacy+' · registro atual','atual'));
    for (const entry of db[table]) {
      if (entry.id !== selected && !normalizeSearch(searchText(entry)).includes(query)
          && !(document && entry.cnpj?.includes(document))) continue;
      select.add(new Option(entryLabel(entry),entry.id));
    }
    select.value = selected;
  }
  search.oninput = ()=>populate(select.value);
  populate(initial);
  if (unavailableRegistries.has(table)) {
    controls.append('Este cadastro aguarda a atualização do banco de dados.');
    return;
  }
  writeAction(title,()=>{
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label',title);
    dialog.innerHTML = '<h2></h2><form></form>';
    document.body.append(dialog);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    edit(title,fields(search.value.trim()),saveRecord,{
      dialog,
      decorate:table === 'orgaos_compradores' ? agencyLookup : undefined,
      onSaved:entry=>{search.value='';populate(entry.id);apply?.(entry);select.focus();}
    });
  },controls);
}

function edital(row = {}) {
  edit(row.id ? 'Atualizar oportunidade' : 'Nova oportunidade',[
    ['numero','Número do processo','text',row.numero],
    ['numero_pregao','Número do pregão','text',row.numero_pregao],
    ['orgao','Órgão comprador','select','',[]],
    ['modalidade','Modalidade ou procedimento','select',row.modalidade ?? modalities[0],modalities],
    ['modo_disputa','Forma de disputa','select',row.modo_disputa??'item',[['item','Por item'],['lote','Por lote']]],
    ['objeto','Objeto da contratação','textarea',row.objeto],
    ['edital_url','Link da publicação do edital','url',row.edital_url],
    ['local_disputa','Local ou portal da disputa','text',row.local_disputa],
    ['edital_pdf','Anexar edital em PDF','file'],
    ['sessao','Data da sessão','date',row.sessao],
    ['empresa_id','CNPJ participante','select',row.empresa_id ?? '',[['','A definir'],...db.empresas.map(e => [e.id,e.nome+' · '+e.cnpj])]],
    ['status','Situação','select',row.status ?? stages[0],stages],
    ['parecer','Parecer da equipe','text',row.parecer]
  ], async values => {
    const agency = values.orgao === 'atual' ? row.orgao : db.orgaos_compradores.find(entry=>entry.id===values.orgao)?.nome;
    if (!agency) throw new Error('Selecione um órgão comprador do cadastro.');
    if (values.status === 'Aprovado' && !values.empresa_id) throw new Error('Escolha o CNPJ participante antes de aprovar.');
    if (['Aprovado','Reprovado'].includes(values.status) && !values.parecer.trim()) throw new Error('Registre o motivo da decisão.');
    const numero = values.numero.trim();
    if (!numero) throw new Error('Informe o número do processo.');
    const numeroPregao = values.modalidade.startsWith('Pregão ') ? values.numero_pregao.trim() : '';
    if (values.modalidade.startsWith('Pregão ') && !numeroPregao && (!row.id || row.modalidade !== values.modalidade || row.numero_pregao)) {
      throw new Error('Informe o número do pregão.');
    }
    const {edital_pdf:file,...data} = values;
    if (row.id && values.modo_disputa !== (row.modo_disputa??'item') && db.itens.some(item=>item.edital_id===row.id)) throw new Error('A forma de disputa só pode ser alterada antes de cadastrar os itens.');
    data.objeto = data.objeto.trim();
    if (!data.objeto && (!row.id || row.objeto)) throw new Error('Informe o objeto da contratação.');
    const editalUrl = data.edital_url.trim();
    if (editalUrl && !safeWebUrl(editalUrl)) throw new Error('Informe um link HTTP ou HTTPS para o edital.');
    if (file.size) {
      data.edital_pdf = await encodePdf(file);
      data.edital_pdf_nome = file.name;
    }
    return save('editais',{...data,numero,numero_pregao:numeroPregao || null,edital_url:editalUrl || null,
      local_disputa:data.local_disputa.trim() || null,orgao:agency,empresa_id:values.empresa_id || null,sessao:values.sessao || null},row.id);
  },{decorate:form=>{
    if (row.edital_pdf_nome) form.elements.namedItem('edital_pdf').closest('label').append('Arquivo atual: '+row.edital_pdf_nome);
    if (row.id && !row.objeto) form.elements.namedItem('objeto').required = false;
    const modalidade = form.elements.namedItem('modalidade');
    const pregao = form.elements.namedItem('numero_pregao');
    const syncPregao = () => {
      const visible = modalidade.value.startsWith('Pregão ');
      pregao.closest('label').hidden = !visible;
      pregao.closest('label').style.display = visible ? '' : 'none';
      pregao.required = visible && (!row.id || row.modalidade !== modalidade.value || Boolean(row.numero_pregao));
    };
    modalidade.addEventListener('change',syncPregao);
    syncPregao();
    const cnpjLabel = entry=>entry.nome+' · '+entry.cnpj;
    registryPicker(form,{name:'orgao',table:'orgaos_compradores',label:'Buscar órgão no cadastro',
      placeholder:'Nome, CNPJ ou município',title:'Cadastrar órgão comprador',fields:nome=>agencyFields({nome}),
      saveRecord:saveAgency,entryLabel:cnpjLabel,searchText:entry=>cnpjLabel(entry)+' '+entry.municipio,
      initial:row.orgao?'atual':'',legacy:row.orgao});
    registryPicker(form,{name:'empresa_id',table:'empresas',label:'Buscar CNPJ participante',
      placeholder:'Nome ou CNPJ',title:'Cadastrar CNPJ participante',fields:nome=>companyFields({nome}),
      saveRecord:saveCompany,entryLabel:cnpjLabel,searchText:cnpjLabel,initial:row.empresa_id??''});
  }});
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ['http:','https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

async function encodePdf(file) {
  if (!file.size || file.size > 5*1024*1024 || await file.slice(0,5).text() !== '%PDF-') {
    throw new Error('Escolha um PDF válido de até 5 MB.');
  }
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(reader.result.split(',')[1]);
    reader.onerror = ()=>reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function downloadEdital(row) {
  let stored = row;
  if (client) {
    const {data,error} = await client.from('editais').select('edital_pdf,edital_pdf_nome').eq('grupo_id',group).eq('id',row.id).single();
    if (error) throw error;
    stored = data;
  }
  if (!stored.edital_pdf) throw new Error('O edital anexado está indisponível.');
  const bytes = Uint8Array.from(atob(stored.edital_pdf),character=>character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = stored.edital_pdf_nome || 'edital.pdf';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

function catalogFields(row = {}) {
  return [
    ['descricao','Descrição','text',row.descricao],
    ['tipo','Tipo','select',row.tipo ?? 'Produto',['Produto','Serviço']],['unidade','Unidade de medida','text',row.unidade],
    ['marca','Marca','text',row.marca],['detalhes','Detalhes','text',row.detalhes],
    ['observacao','Observações','text',row.observacao],['custo','Custo unitário (R$)','number',row.custo],
    ['margem','Margem sugerida (%)','number',row.margem ?? 18]
  ];
}

function catalogValues(values) {
  const record = Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value.trim()]));
  if (!record.descricao || !record.unidade) throw new Error('Informe descrição e unidade.');
  if (!['Produto','Serviço'].includes(record.tipo)) throw new Error('Informe Produto ou Serviço no tipo.');
  for (const key of ['custo','margem']) {
    if (!/^\d+(?:[.,]\d+)?$/.test(record[key])) throw new Error('Informe custo e margem como números.');
    record[key] = Number(record[key].replace(',','.'));
  }
  if (!Number.isFinite(record.custo) || record.margem >= 100) throw new Error('Confira o custo e informe uma margem inferior a 100%.');
  return record;
}

async function saveCatalog(values,id) {
  const recordId = await save('catalogo',catalogValues(values),id);
  return db.catalogo.find(entry=>entry.id===recordId);
}

function renderRegistry(view, agencies) {
  const table = agencies ? 'orgaos_compradores' : 'catalogo';
  const singular = agencies ? 'órgão comprador' : 'produto ou serviço';
  const heading = agencies ? 'Órgãos compradores' : 'Catálogo de produtos e serviços';
  const section = panel(view,`<h2>${heading}</h2>`);
  if (unavailableRegistries.has(table)) {
    section.insertAdjacentHTML('beforeend','<p>Este cadastro aguarda a atualização do banco de dados.</p>');
    return;
  }
  function open(row = {}) {
    edit((row.id ? 'Editar ' : 'Cadastrar ')+singular,agencies ? agencyFields(row) : catalogFields(row),
      values=>agencies ? saveAgency(values,row.id) : saveCatalog(values,row.id),{decorate:agencies ? agencyLookup : undefined});
  }
  writeAction('Cadastrar '+singular,()=>open(),section,true);
  if (!agencies && canWrite()) {
    action('Importar catálogo Excel',importCatalog,section);
    section.insertAdjacentHTML('beforeend',' <a href="./modelo-cadastro-produtos-servicos.xlsx" download>Baixar modelo do catálogo (.xlsx)</a>');
  }
  section.insertAdjacentHTML('beforeend','<label>Buscar cadastro<input type="search"></label><div></div>');
  const search = section.querySelector('input');
  const list = section.lastElementChild;
  function draw() {
    const query = search.value.trim().toLocaleLowerCase('pt-BR');
    list.replaceChildren();
    const rows = db[table].filter(row => (agencies ? [row.nome,row.cnpj,row.municipio,row.uf]
      : [row.codigo,row.descricao,row.tipo,row.marca]).some(value => String(value ?? '').toLocaleLowerCase('pt-BR').includes(query)));
    if (!rows.length) list.textContent = 'Nenhum cadastro encontrado.';
    for (const row of rows) {
      const title = agencies ? row.nome : row.codigo+' · '+row.descricao;
      const subtitle = agencies ? row.cnpj+' · '+row.municipio+'/'+row.uf
        : row.tipo+' · '+row.unidade+' · Custo '+money.format(row.custo);
      const card = panel(list,'<strong>'+escape(title)+'</strong><p>'+escape(subtitle)+'</p>');
      writeAction('Editar',()=>open(row),card);
    }
  }
  search.oninput = draw;
  draw();
}

function item(row, previous = {}) {
  edit(previous.id ? 'Editar item da proposta' : 'Novo item da proposta',[
    ['produto_catalogo','Vincular produto ou serviço do catálogo','select','',[]],
    ...(row.modo_disputa==='lote' ? [['lote','Número do lote','text',previous.lote]] : []),
    ['codigo','Número do item','text',previous.codigo],
    ['descricao','Descrição do edital','textarea',previous.descricao],
    ['origem_descricao','Descrição que sai na proposta','select',previous.usar_descricao_interna?'interna':'edital',[['edital','Descrição do edital'],['interna','Descrição interna da empresa']]],
    ['quantidade','Quantidade solicitada','number',previous.quantidade],
    ['unidade','Unidade de medida','text',previous.unidade],
    ['marca_item','Marca','text',previous.marca],
    ['embalagem','Unidades por embalagem','number',previous.embalagem ?? 1],
    ['custo_embalagem','Custo por embalagem (R$)','number',previous.custo_embalagem],
    ['margem','Margem bruta desejada (%)','number',previous.margem ?? 18],
    ['fornecedor','Fornecedor','text',previous.fornecedor],
    ['observacao_item','Observação interna','textarea',previous.observacao]
  ], values=>save('itens',proposalItem(row,values,previous),previous.id),{decorate:form=>{
    form.elements.namedItem('produto_catalogo').required = false;
    if (previous.id && !previous.unidade) form.elements.namedItem('unidade').required = false;
    const label = entry=>entry.codigo+' · '+entry.descricao;
    registryPicker(form,{name:'produto_catalogo',table:'catalogo',label:'Buscar produto ou serviço',
      placeholder:'Código ou descrição',title:'Cadastrar produto ou serviço',fields:descricao=>catalogFields({descricao}),
      saveRecord:saveCatalog,entryLabel:label,searchText:entry=>label(entry)+' '+(entry.marca??''),initial:previous.catalogo_id??'',
      apply:entry=>{
        if (!entry) return;
        const fields = form.elements;
        fields.namedItem('unidade').value ||= entry.unidade ?? '';
        fields.namedItem('marca_item').value ||= entry.marca ?? '';
        if (!fields.namedItem('custo_embalagem').value) {
          fields.namedItem('custo_embalagem').value = (Number(fields.namedItem('embalagem').value)||1)*Number(entry.custo);
        }
      }});
  }});
}

function proposalItem(row, values, previous = {}) {
  const entry = db.catalogo.find(item=>item.id===values.produto_catalogo);
  const codigo = values.codigo.trim();
  const descricao = values.descricao.trim();
  const unidade = values.unidade.trim();
  if (!codigo || !descricao || (!unidade && !previous.id)) throw new Error('Informe número do item, descrição e unidade.');
  const numbers = Object.fromEntries(['quantidade','embalagem','custo_embalagem','margem'].map(key=>[key,Number(String(values[key]).replace(',','.'))]));
  if (!Object.keys(numbers).every(key=>String(values[key]).trim() && Number.isFinite(numbers[key])) || numbers.quantidade<=0 || numbers.embalagem<=0 || numbers.custo_embalagem<0 || numbers.margem<0 || numbers.margem>=100) {
    throw new Error('Confira quantidade, embalagem, custo e margem. A margem deve ser menor que 100%.');
  }
  const lote = (values.lote??'').trim();
  if (row.modo_disputa==='lote' ? !lote : lote) throw new Error(row.modo_disputa==='lote'?'Informe o número do lote.':'Deixe o lote vazio na disputa por item.');
  if (db.itens.some(item=>item.edital_id===row.id && (item.lote??'')===lote && item.codigo===codigo && item.id!==previous.id)) throw new Error('Número de item já cadastrado nesta proposta.');
  const usar_descricao_interna = values.origem_descricao === 'interna';
  if (usar_descricao_interna && !entry?.descricao) throw new Error('Vincule um produto do catálogo para usar a descrição interna.');
  return {...numbers,lote,codigo,descricao,unidade,edital_id:row.id,catalogo_id:entry?.id??null,
    descricao_interna:entry?.id===previous.catalogo_id ? previous.descricao_interna??entry?.descricao??null : entry?.descricao??null,
    usar_descricao_interna,marca:values.marca_item.trim(),fornecedor:values.fornecedor.trim(),observacao:values.observacao_item.trim()};
}

function documentEditor(row, previous = {}) {
  edit(previous.id ? 'Conferir documento' : 'Adicionar requisito',[
    ['nome','Documento exigido','text',previous.nome],
    ['validade','Validade','date',previous.validade],
    ['conferido','Situação','select',previous.conferido ? 'sim' : 'nao',[['nao','Pendente'],['sim','Conferido']]]
  ], values => save('documentos',{...values,edital_id:row.id,validade:values.validade || null,conferido:values.conferido === 'sim'},previous.id));
}

const price = i => Number(i.preco_unitario ?? (Math.round((i.custo_embalagem / i.embalagem / (1 - i.margem / 100) + Number.EPSILON)*100)/100));
const total = rows => rows.reduce((sum,row) => sum + Math.round(price(row)*row.quantidade*100),0)/100;
const panel = (container, html) => {
  const section = document.createElement('section');
  section.className = 'panel';
  section.innerHTML = html;
  container.append(section);
  return section;
};

async function call(name, args) {
  const {data,error} = await client.rpc(name,args);
  if (error) throw new Error(error.message);
  return data;
}

async function openClients() {
  clients = await call('licitacoes_clientes');
  page = 'clientes'; activeEdital = null; render();
}

async function openTeam() {
  team = await call('licitacoes_equipe',{cliente:group});
  page = 'equipe'; activeEdital = null; render();
}

function renderClients(view) {
  const section = panel(view,'<h2>Mestre Gerenciador</h2><p>Cadastre empresas clientes e defina o administrador de cada espaço.</p>');
  action('Cadastrar empresa cliente', () => edit('Nova empresa cliente', [
    ['nome_cliente','Nome da empresa','text'],['email_admin','E-mail do administrador cadastrado','email']
  ], async values => {
    await call('licitacoes_criar_cliente',values);
    clients = await call('licitacoes_clientes');
  }), section,true);
  for (const customer of clients) panel(section,'<strong>'+escape(customer.nome)+'</strong><p>'+escape(customer.integrantes)+' integrante(s)</p>');
}

function renderTeam(view) {
  const section = panel(view,'<h2>Equipe da empresa</h2><p>Gerencie o acesso ao seu espaço de trabalho.</p>');
  action('Adicionar integrante', () => edit('Adicionar integrante',[
    ['email_membro','E-mail do usuário cadastrado','email'],
    ['papel_membro','Perfil','select','operador',[['operador','Operador'],['leitor','Leitor']]]
  ], async values => {
    await call('licitacoes_adicionar_membro',{...values,cliente:group});
    team = await call('licitacoes_equipe',{cliente:group});
  }),section,true);
  for (const member of team) panel(section,'<strong>'+escape(member.email)+'</strong><p>'+escape(member.papel)+'</p>');
}

function renderEditalIndex(view, docs) {
  const section = panel(view,docs ? '<h2>Documentação por edital</h2>' : '<h2>Propostas por edital</h2>');
  const rows = db.editais.filter(row => row.status === 'Aprovado' || db.itens.some(item => item.edital_id === row.id) || (docs && db.documentos.some(doc => doc.edital_id === row.id)));
  if (!rows.length) section.append(Object.assign(document.createElement('p'),{textContent:'Nenhum edital disponível. Aprove uma oportunidade na Captação.'}));
  for (const row of rows) {
    const card = panel(section,'<strong>'+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p>');
    action(docs?'Abrir checklist':'Abrir proposta',()=>{detailMode=docs?'docs':'proposal';activeEdital=row.id;render();},card);
  }
}

const proposalStages = ['A montar','Em preparação','Vincular documentação','Conferência 01','Conferência 02','Enviar para disputa'];
const proposalStage = row=>Number(row.etapa_proposta ?? 0);

async function moveProposal(row,destination) {
  const origin = proposalStage(row);
  if (Math.abs(destination-origin)!==1) throw new Error('Mova a proposta uma coluna por vez.');
  const {error} = await client.rpc('mover_proposta',{p_edital:row.id,p_origem:origin,p_destino:destination});
  if (error) throw error;
  await load();
  render();
  if (destination===5) {
    const scope = {grupo_id:row.grupo_id,empresa_id:row.empresa_id,edital_id:row.id};
    const {data,error} = await client.from('anexos_proposta').select('arquivo_id').match(scope);
    if (error) throw error;
    await downloadProposalPackage(row,scope,new Set(data.map(link=>link.arquivo_id)));
  }
}

function proposalControls(parent,row) {
  if (!client || !canWrite()) return;
  const stage = proposalStage(row);
  if (stage>0) action('Voltar para '+proposalStages[stage-1],()=>moveProposal(row,stage-1),parent);
  if (stage<5) action(proposalStages[stage+1],()=>moveProposal(row,stage+1),parent,true);
}

const quoteStages = ['Em cotação','Revisão','Enviado'];
const budgetStages = ['Em elaboração','Revisão e assinatura','Enviado'];
const isBudget = row=>row.tipo==='orcamento';
const quoteDate = new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'});

async function updateQuote(row,values) {
  if (!client) return save('cotacoes',values,row.id);
  const {data,error} = await client.from('cotacoes').update(values).match({grupo_id:group,id:row.id,revisao:row.revisao}).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('A cotação mudou. Atualize a tela antes de salvar.');
  await load();
  return data.id;
}

function budgetForm(view,row) {
  edit(row.id?'Editar orçamento':'Novo orçamento',[
    ['titulo','Referência ou assunto do pedido','text',row.titulo],
    ['empresa_id','Empresa emitente','select',row.empresa_id ?? db.empresas[0]?.id,db.empresas.map(company=>[company.id,company.nome+' · '+company.cnpj])],
    ['orgao_id','Órgão solicitante','select','',[]],
    ['email','E-mail do órgão','email',row.email],
    ['observacao','Condições comerciais e observações','textarea',row.observacao]
  ],async values=>{
    const orgao=db.orgaos_compradores.find(entry=>entry.id===values.orgao_id);
    if (!values.empresa_id || !orgao || !values.titulo.trim()) throw new Error('Informe a referência, a empresa emitente e o órgão solicitante.');
    const data={...values,titulo:values.titulo.trim(),fornecedor:orgao.nome};
    return row.id?updateQuote(row,data):save('cotacoes',client?{...data,tipo:'orcamento'}:{...data,tipo:'orcamento',etapa:0,itens:[],historico:[]});
  },{onSaved:id=>openQuote(view,id),decorate:form=>registryPicker(form,{name:'orgao_id',table:'orgaos_compradores',label:'Buscar prefeitura ou órgão',
    placeholder:'Selecione um órgão solicitante',title:'Cadastrar órgão comprador',fields:name=>agencyFields({nome:name}),saveRecord:values=>saveAgency(values),
    entryLabel:entry=>entry.nome+' · '+entry.cnpj,searchText:entry=>[entry.nome,entry.cnpj].join(' '),initial:row.orgao_id??'',
    apply:entry=>{const email=form.elements.namedItem('email'); if (entry?.email && !email.value) email.value=entry.email;}})});
}

const budgetPdfItem=item=>({...item,codigo:item.codigo,preco_unitario:item.preco});
function renderBudgetActions(section,view,row) {
  const priced=row.itens.length && row.itens.every(item=>item.preco!=null);
  if (priced) action('Baixar orçamento em PDF',()=>downloadProposalPdf({
    ...row,orgao:row.fornecedor,numero:row.titulo,objeto:row.titulo
  },row.itens.map(budgetPdfItem),{budget:true}),section);
  if (priced) section.insertAdjacentHTML('beforeend','<p><strong>Total do orçamento: '+money.format(total(row.itens.map(budgetPdfItem)))+'</strong></p>');
  if (row.assinado_em) action('Baixar orçamento assinado',async()=>{
    const {data,error}=await client.from('cotacoes').select('pdf_assinado').match({grupo_id:group,id:row.id}).single();
    if (error) throw error;
    if (!data.pdf_assinado) throw new Error('O PDF assinado não está disponível.');
    saveQuoteFile(new Blob([pdfBytes(data.pdf_assinado)],{type:'application/pdf'}),'orcamento-assinado-'+row.id.slice(0,8)+'.pdf');
  },section);
  if (client && row.etapa===1 && priced) {
    section.insertAdjacentHTML('beforeend','<p>Baixe o PDF, assine digitalmente ou à mão e anexe o documento assinado. Envie o arquivo ao órgão pelo canal solicitado e depois marque como enviado.</p>');
    writeAction(row.assinado_em?'Substituir PDF assinado':'Anexar orçamento assinado',()=>edit('Anexar orçamento assinado',
      [['arquivo','Orçamento assinado em PDF','file']],async ({arquivo})=>updateQuote(row,{pdf_assinado:await encodePdf(arquivo)}),
      {onSaved:id=>openQuote(view,id)}),section,true);
  }
}

function quoteForm(view,row={}) {
  if (page==='orcamento') return budgetForm(view,row);
  edit(row.id?'Editar cotação':'Nova cotação',[
    ['titulo','Título da cotação','text',row.titulo],
    ['empresa_id','Empresa solicitante','select',row.empresa_id ?? db.empresas[0]?.id,db.empresas.map(company=>[company.id,company.nome+' · '+company.cnpj])],
    ['fornecedor','Fornecedor','text',row.fornecedor],
    ['email','E-mail do fornecedor','email',row.email],
    ['observacao','Instruções para o fornecedor','textarea',row.observacao]
  ], async values=>{
    values.titulo=values.titulo.trim();
    values.fornecedor=values.fornecedor.trim();
    if (!values.empresa_id) throw new Error('Cadastre uma empresa solicitante nas Configurações.');
    if (!values.titulo || !values.fornecedor) throw new Error('Informe o título e o fornecedor.');
    return row.id ? updateQuote(row,values) : save('cotacoes',client?values:{...values,etapa:0,itens:[],historico:[]});
  },{onSaved:id=>openQuote(view,id)});
}

function quoteItem(view,row,item) {
  const budget=isBudget(row);
  const fields = item ? [
    ['quantidade','Quantidade solicitada','number',item.quantidade],
    ['preco',budget?'Preço unitário ofertado (R$)':'Preço unitário retornado pelo fornecedor','number',item.preco]
  ] : [
    ['catalogo_id','Produto ou serviço','select','',[]],
    ['quantidade','Quantidade solicitada','number',1]
  ];
  edit(item?'Editar item da cotação':'Adicionar item do catálogo',fields,async values=>{
    if (!item && row.itens.some(entry=>entry.catalogo_id===values.catalogo_id)) throw new Error('Este item já está na cotação.');
    const source = db.catalogo.find(entry=>entry.id===values.catalogo_id);
    if (!item && !source) throw new Error('Selecione um item do catálogo.');
    const quantidade = Number(values.quantidade);
    const preco = item ? (values.preco ? Number(values.preco) : null) : budget && source ? financialPrice(source)?.final ?? null : null;
    if (!Number.isFinite(quantidade) || quantidade<=0 || (preco!==null && (!Number.isFinite(preco) || preco<0 || preco>=1e10))) throw new Error('Confira a quantidade e o preço informado.');
    const picked = item ?? {catalogo_id:source.id,codigo:source.codigo,descricao:source.descricao,unidade:source.unidade,marca:source.marca,custo_base:Number(source.custo)};
    const entry = {...picked,quantidade,preco};
    const itens = item ? row.itens.map(existing=>existing.catalogo_id===item.catalogo_id?entry:existing) : [...row.itens,entry];
    return updateQuote(row,{itens});
  },{onSaved:id=>openQuote(view,id),decorate:form=>{
    if (item) {
      form.elements.namedItem('preco').required=budget;
      if (row.etapa===2) form.elements.namedItem('quantidade').readOnly=true;
      return;
    }
    registryPicker(form,{name:'catalogo_id',table:'catalogo',label:'Buscar no catálogo',placeholder:'Selecione um produto ou serviço',
      title:'Cadastrar produto ou serviço',fields:descricao=>catalogFields({descricao}),saveRecord:values=>saveCatalog(values),
      entryLabel:entry=>entry.codigo+' · '+entry.descricao,searchText:entry=>[entry.codigo,entry.descricao,entry.marca].join(' ')});
  }});
}

async function moveQuote(row,destination) {
  if (Math.abs(destination-row.etapa)!==1) throw new Error('Mova a cotação uma coluna por vez.');
  if (destination>row.etapa && !row.itens.length) throw new Error('Inclua pelo menos um item do catálogo.');
  if (isBudget(row) && destination===2 && !row.assinado_em) throw new Error('Anexe o orçamento assinado antes de marcar como enviado.');
  const values={etapa:destination};
  if (!client) values.historico=[...row.historico,{origem:row.etapa,destino:destination,usuario:'Demonstração',data:new Date().toISOString()}];
  await updateQuote(row,values);
}

function renderQuotes(view) {
  if (unavailableRegistries.has('cotacoes')) {
    panel(view,'<p>As cotações aguardam a atualização do banco de dados.</p>');
    return;
  }
  const budget=page==='orcamento';
  const stages=budget?budgetStages:quoteStages;
  const records=db.cotacoes.filter(row=>isBudget(row)===budget);
  writeAction(budget?'Novo orçamento':'Nova cotação',()=>quoteForm(view),byId('page-actions'),true);
  const grid=document.createElement('section');
  grid.style.cssText='display:grid;grid-template-columns:repeat(3,minmax(210px,1fr));gap:12px;overflow:auto';
  for (const [index,stage] of stages.entries()) {
    const rows=records.filter(row=>row.etapa===index);
    const lane=document.createElement('section');
    lane.className='lane';
    lane.innerHTML='<h3>'+stage+' · '+rows.length+'</h3>';
    if (canWrite()) {
      lane.ondragover=event=>event.preventDefault();
      lane.ondrop=event=>{
        event.preventDefault();
        const row=records.find(record=>record.id===event.dataTransfer.getData('text/plain'));
        if (row && row.etapa!==index) moveQuote(row,index).then(render).catch(error=>message(error.message));
      };
    }
    for (const row of rows) {
      const card=panel(lane,'<strong>'+escape(row.titulo)+'</strong><p>'+escape(row.fornecedor)+'</p><p>'+row.itens.length+' item(ns)</p>');
      card.classList.add('card');
      card.draggable=canWrite();
      card.ondragstart=event=>event.dataTransfer.setData('text/plain',row.id);
      action(budget?'Abrir orçamento':'Abrir cotação',()=>openQuote(view,row.id),card);
    }
    grid.append(lane);
  }
  view.append(grid);
}

function openQuote(view,id) {
  const row=db.cotacoes.find(entry=>entry.id===id);
  if (!row || page!==(isBudget(row)?'orcamento':'cotacoes')) return;
  const budget=isBudget(row);
  const stages=budget?budgetStages:quoteStages;
  view.replaceChildren();
  byId('page-actions').replaceChildren();
  action('Voltar ao quadro',render,byId('page-actions'));
  const section=panel(view,'<h2>'+escape(row.titulo)+'</h2><p>'+escape(row.fornecedor)+' · '+stages[row.etapa]+'</p>');
  if (row.observacao) section.insertAdjacentHTML('beforeend','<p>'+escape(row.observacao)+'</p>');
  if (row.etapa<2) {
    writeAction(budget?'Editar orçamento':'Editar cotação',()=>quoteForm(view,row),section);
    writeAction('Adicionar item do catálogo',()=>quoteItem(view,row),section,true);
  }
  if (row.etapa>0) writeAction('Voltar para '+stages[row.etapa-1],async()=>{await moveQuote(row,row.etapa-1);openQuote(view,id);},section);
  if (row.etapa<2) writeAction(row.etapa===1?'Marcar como enviado':'Mover para revisão',async()=>{await moveQuote(row,row.etapa+1);openQuote(view,id);},section);
  if (budget) renderBudgetActions(section,view,row);
  if (!budget && row.itens.length) {
    action('Baixar PDF para o fornecedor',()=>downloadQuote(row,'pdf'),section);
    action('Baixar XML para o fornecedor',()=>downloadQuote(row,'xml'),section);
  }
  if (!budget && row.etapa===2 && row.itens.some(item=>item.preco!=null)) action('Ver preços no Financeiro',()=>{page='financeiro';render();},section);
  const table=quoteTable(section,['Código','Produto ou serviço','Quantidade','Unidade',budget?'Preço ofertado':'Preço retornado',...(budget?['Total']:[]),'Ações']);
  for (const item of row.itens) {
    const line=table.insertRow();
    for (const value of [item.codigo,item.descricao,item.quantidade,item.unidade,item.preco == null?'Aguardando preço':money.format(item.preco),...(budget?[item.preco==null?'—':money.format(total([budgetPdfItem(item)]))]:[])]) line.insertCell().textContent=value;
    const controls=line.insertCell();
    if (item.aplicado_em) controls.textContent='Custo aplicado em '+quoteDate.format(new Date(item.aplicado_em));
    else if (!budget || row.etapa<2) writeAction(row.etapa===2?'Registrar preço':'Editar item',()=>quoteItem(view,row,item),controls);
    if (row.etapa<2 && !item.aplicado_em) writeAction('Remover',async()=>{
      await updateQuote(row,{itens:row.itens.filter(other=>other.catalogo_id!==item.catalogo_id)});
      openQuote(view,id);
    },controls);
  }
  if (row.historico.length) {
    const history=panel(view,'<h3>Histórico de movimentações</h3>');
    const list=document.createElement('ul');
    list.style.cssText='list-style:none;margin:4px 0;padding:0;font-size:9pt;line-height:1.45';
    for(const entry of [...row.historico].reverse()) {
      const line=document.createElement('li');
      line.textContent=[entry.origem==null?stages[entry.destino]:stages[entry.origem]+' → '+stages[entry.destino],entry.usuario,quoteDate.format(new Date(entry.data))].filter(Boolean).join(' · ');
      list.append(line);
    }
    history.append(list);
  }
}

function quoteTable(parent,headers) {
  const wrap=document.createElement('div');
  wrap.className='scroll';
  wrap.innerHTML='<table><thead><tr>'+headers.map(label=>'<th scope="col">'+label+'</th>').join('')+'</tr></thead><tbody></tbody></table>';
  parent.append(wrap);
  return wrap.querySelector('tbody');
}

function saveQuoteFile(blob,name) {
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download=name;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

async function downloadQuote(row,format) {
  const company=db.empresas.find(entry=>entry.id===row.empresa_id);
  const name='cotacao-'+row.id.slice(0,8);
  if (format==='xml') {
    const tag=(key,value)=>'<'+key+'>'+escape(value)+'</'+key+'>';
    const itemTags=row.itens.map(item=>'<item>'+['codigo','descricao','marca','unidade','quantidade'].map(key=>tag(key,item[key])).join('')+tag('preco_unitario','')+'</item>').join('');
    const xml='<?xml version="1.0" encoding="UTF-8"?><cotacao>'+tag('referencia',name)+tag('titulo',row.titulo)+tag('empresa',company?.nome)+tag('cnpj',company?.cnpj)+tag('fornecedor',row.fornecedor)+tag('instrucoes',row.observacao)+'<itens>'+itemTags+'</itens></cotacao>';
    saveQuoteFile(new Blob([xml],{type:'application/xml;charset=utf-8'}),name+'.xml');
    return;
  }
  const Pdf=await proposalPdfLibrary();
  const pdf=new Pdf({unit:'mm',format:'a4'});
  let y=18;
  function write(value,size=10,bold=false) {
    pdf.setFont('helvetica',bold?'bold':'normal');
    pdf.setFontSize(size);
    for (const text of pdf.splitTextToSize(String(value??''),178)) {
      if (y>277) { pdf.addPage();y=18; }
      pdf.text(text,16,y);
      y+=size*.46;
    }
  }
  write('SOLICITAÇÃO DE COTAÇÃO DE PREÇOS',15,true);
  write(row.titulo,12,true);
  write('Referência: '+name);
  write('Solicitante: '+(company?.nome??'')+' · CNPJ '+(company?.cnpj??''));
  write('Fornecedor: '+row.fornecedor);
  if (row.observacao) write(row.observacao);
  for (const item of row.itens) {
    if (y>258) { pdf.addPage();y=18; }
    y+=4;
    write(item.codigo+' · '+item.descricao,10,true);
    write('Quantidade: '+item.quantidade+' '+item.unidade+(item.marca?' · Marca: '+item.marca:''));
    write('Preço unitário: R$ ____________________');
  }
  pdf.save(name+'.pdf');
}

function financialPrice(item) {
  const base=Number(item.custo)+Number(item.imposto_compra_unitario ?? 0);
  const rate=(Number(item.margem)+Number(item.imposto_venda_pct ?? 0))/100;
  if (rate>=1 || !Number.isFinite(base+rate)) return null;
  const calculated=Math.round((base/(1-rate)+Number.EPSILON)*100)/100;
  return {base,calculated,final:item.preco_venda_manual==null?calculated:Number(item.preco_venda_manual)};
}

function editFinancialPrice(item) {
  const keys=['custo','imposto_compra_unitario','imposto_venda_pct','margem','preco_venda_manual'];
  edit('Ajustar preço · '+item.codigo,[
    ['custo','Custo unitário sem os impostos adicionais (R$)','number',item.custo],
    ['imposto_compra_unitario','Imposto da compra ainda fora do custo, por unidade (R$)','number',item.imposto_compra_unitario ?? 0],
    ['imposto_venda_pct','Impostos sobre o preço de venda (%)','number',item.imposto_venda_pct ?? 0],
    ['margem','Margem desejada sobre a venda (%)','number',item.margem],
    ['preco_venda_manual','Preço de venda manual (R$)','number',item.preco_venda_manual]
  ],async values=>{
    const fields=Object.fromEntries(keys.map(key=>[key,key==='preco_venda_manual' && values[key]===''?null:Number(values[key])]));
    for (const key of keys) {
      const value=fields[key];
      if (value!==null && (!Number.isFinite(value) || value<0 || value>=1e10)) throw new Error('Confira os valores informados.');
    }
    if (fields.margem+fields.imposto_venda_pct>=100) throw new Error('A soma da margem e dos impostos sobre a venda deve ser menor que 100%.');
    if (!client) return save('catalogo',fields,item.id);
    let request=client.from('catalogo').update(fields).match({id:item.id,grupo_id:group});
    for (const key of keys) request=item[key]==null?request.is(key,null):request.eq(key,item[key]);
    const {data,error}=await request.select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('O item foi alterado. Reabra o Financeiro para conferir os dados atualizados.');
    await load();
  },{decorate:form=>{
    form.elements.namedItem('preco_venda_manual').required=false;
    const preview=document.createElement('p');
    preview.setAttribute('role','status');
    form.prepend(item.descricao);
    form.lastElementChild.before(preview);
    function update() {
      const values=Object.fromEntries(new FormData(form));
      if (values.preco_venda_manual==='') values.preco_venda_manual=null;
      const result=financialPrice(values);
      preview.textContent=result?'Custo com imposto da compra '+money.format(result.base)+' · Preço calculado '+money.format(result.calculated)+' · Preço de venda '+money.format(result.final):'A soma da margem e dos impostos sobre a venda deve ser menor que 100%.';
    }
    form.addEventListener('input',update);
    update();
  }});
}

function renderFinancialPrices(view) {
  const section=panel(view,'<h2>Formação de preço por item</h2><label>Buscar produto ou serviço<input type="search" placeholder="Código ou descrição"></label>');
  const search=section.querySelector('input');
  const table=quoteTable(section,['Produto ou serviço','Custo base','Imposto na compra','Impostos na venda','Margem','Preço calculado','Preço de venda','Ação']);
  const draw=()=>{
    table.replaceChildren();
    for (const item of db.catalogo) {
      if (!normalizeSearch(item.codigo+' '+item.descricao).includes(normalizeSearch(search.value.trim()))) continue;
      const result=financialPrice(item);
      const line=table.insertRow();
      for (const value of [item.codigo+' · '+item.descricao,money.format(item.custo),money.format(item.imposto_compra_unitario ?? 0),(item.imposto_venda_pct ?? 0)+'%',item.margem+'%',result?money.format(result.calculated):'—',result?money.format(result.final)+(item.preco_venda_manual==null?'':' · manual'):'—']) line.insertCell().textContent=value;
      const cell=line.insertCell();
      writeAction('Ajustar preço',()=>editFinancialPrice(item),cell);
    }
    if (!table.rows.length) {
      const cell=table.insertRow().insertCell();
      cell.colSpan=8;
      cell.textContent='Nenhum produto ou serviço encontrado.';
    }
  };
  search.oninput=draw;
  draw();
}

function renderQuoteFinance(view) {
  renderFinancialPrices(view);
  const section=panel(view,'<h2>Preços recebidos de fornecedores</h2><p>Compare o preço recebido com o custo do catálogo antes de aplicar.</p>');
  const received=db.cotacoes.filter(row=>!isBudget(row) && row.etapa===2).flatMap(row=>row.itens.filter(item=>item.preco!=null).map(item=>({row,item})));
  if (!received.length) { section.append('Nenhum preço recebido registrado em cotações enviadas.'); return; }
  const table=quoteTable(section,['Cotação e fornecedor','Produto ou serviço','Custo atual','Preço recebido','Diferença','Ação']);
  for (const {row,item} of received) {
    const source=db.catalogo.find(entry=>entry.id===item.catalogo_id);
    const line=table.insertRow();
    for (const value of [row.titulo+' · '+row.fornecedor,item.codigo+' · '+item.descricao,source?money.format(source.custo):'Indisponível',money.format(item.preco),source?money.format(item.preco-source.custo):'—']) line.insertCell().textContent=value;
    const controls=line.insertCell();
    if (item.aplicado_em) { controls.textContent='Aplicado em '+quoteDate.format(new Date(item.aplicado_em)); continue; }
    if (!source || !client) continue;
    writeAction('Aplicar ao catálogo',()=>edit('Aplicar custo de '+item.codigo,[],async()=>{
      const {error}=await client.rpc('aplicar_custo_cotado',{p_cotacao:row.id,p_item:item.catalogo_id,p_custo_esperado:source.custo,p_revisao:row.revisao});
      if (error) throw error;
      await load();
    },{decorate:form=>{
      const summary=document.createElement('p');
      summary.textContent=item.descricao+' · '+money.format(source.custo)+' → '+money.format(item.preco);
      form.prepend(summary);
    }}),controls);
  }
}

const disputeStages=['Aguardando disputa','Em disputa','Enviado para acompanhamento'];
const disputeResults=['Sem resultado','Estamos liderando','Concorrente liderando','Ganhamos','Perdemos','Sem vencedor'];
const disputeFinal=s=>disputeResults.slice(3).includes(s);
const unitCost=item=>Number(item.custo_embalagem)/Number(item.embalagem);
const bidFloor=(cost,margin)=>Math.ceil((cost/(1-margin/100)-1e-9)*100)/100;
const bidMargin=(cost,bid)=>bid>0?(1-cost/bid)*100:null;
const disputeItems=row=>db.itens.filter(item=>item.edital_id===row.id);

async function saveDispute(row,record,values) {
  if (!record.id) return save('disputas',{edital_id:row.id,...values});
  const {data,error}=await client.from('disputas').update(values).match({grupo_id:group,id:record.id,revisao:record.revisao}).select('id').maybeSingle();
  if(error) throw error;
  if(!data) throw new Error('A disputa mudou em outra sessão. Atualize a tela e tente novamente.');
  await load();
}

async function moveDispute(row,record,destination) {
  if(Math.abs(record.etapa-destination)!==1) throw new Error('Mova a disputa uma coluna por vez.');
  if(destination===2 && (!disputeItems(row).length || disputeItems(row).some(item=>!disputeFinal(record.resultados[item.id]?.situacao)))) throw new Error('Registre o resultado final de todos os itens antes de enviar.');
  if(!record.id) {
    await saveDispute(row,record,{});
    record=db.disputas.find(entry=>entry.edital_id===row.id);
  }
  await saveDispute(row,record,{etapa:destination});
}

function disputeRules(view,row,record) {
  edit('Configurar farol de margens',[
    ['margem_minima','Margem mínima sobre a venda (%)','number',record.margem_minima],
    ['alerta','Faixa amarela acima da mínima (pontos percentuais)','number',record.alerta]
  ],async values=>{
    const margem_minima=Number(values.margem_minima),alerta=Number(values.alerta);
    if(!Number.isFinite(margem_minima+alerta)||margem_minima<0||alerta<0||margem_minima+alerta>=100) throw new Error('A margem mínima e a faixa de alerta devem somar menos de 100%.');
    await saveDispute(row,record,{margem_minima,alerta});
  },{onSaved:()=>openDispute(view,row)});
}

function editDisputeItem(view,row,record,item) {
  const saved=record.resultados[item.id]??{};
  edit('Lance e resultado · Item '+item.codigo,[
    ['margem','Margem para simular lance (%)','number',saved.margem??item.margem],
    ['lance','Nosso lance unitário (R$)','number',saved.lance],
    ['concorrente','Concorrente líder','text',saved.concorrente],
    ['lance_concorrente','Melhor lance concorrente (R$)','number',saved.lance_concorrente],
    ['situacao','Situação do item','select',saved.situacao??disputeResults[0],disputeResults],
    ['vencedor','Vencedor, se for outra empresa','text',saved.vencedor],
    ['marca_vencedora','Marca vencedora','text',saved.marca_vencedora],
    ['preco_final','Preço vencedor unitário (R$)','number',saved.preco_final],
    ['observacao','Justificativa ou observação','textarea',saved.observacao]
  ],async values=>{
    const result={...values,margem:Number(values.margem)};
    if(!Number.isFinite(result.margem)||result.margem<0||result.margem>=100) throw new Error('Informe uma margem de 0 a menos de 100%.');
    if(!disputeResults.includes(result.situacao)) throw new Error('Informe uma situação válida.');
    for(const key of ['lance','lance_concorrente','preco_final']) {
      result[key]=values[key]===''?null:Number(values[key]);
      if(result[key]!==null && (!Number.isFinite(result[key])||result[key]<=0)) throw new Error('Informe valores unitários maiores que zero.');
    }
    if(['Ganhamos','Perdemos'].includes(result.situacao) && result.preco_final==null) throw new Error('Informe o preço vencedor.');
    if(result.situacao==='Perdemos' && !result.vencedor.trim()) throw new Error('Informe o nome do vencedor.');
    await saveDispute(row,record,{resultados:{...record.resultados,[item.id]:result}});
  },{onSaved:()=>openDispute(view,row),decorate:form=>{
    for(const key of ['lance','concorrente','lance_concorrente','vencedor','marca_vencedora','preco_final']) form.elements.namedItem(key).required=false;
    const preview=document.createElement('p');
    preview.setAttribute('role','status');
    form.lastElementChild.before(preview);
    const update=()=>{
      const fields=form.elements;
      const margin=Number(fields.namedItem('margem').value);
      const lance=Number(fields.namedItem('lance').value);
      preview.textContent=margin>=0 && margin<100?'Piso '+money.format(bidFloor(unitCost(item),record.margem_minima))+' · Lance pela margem '+money.format(bidFloor(unitCost(item),margin))+(lance>0?' · Margem do lance '+bidMargin(unitCost(item),lance).toFixed(2)+'%':''):'Informe uma margem menor que 100%.';
    };
    form.addEventListener('input',update);
    update();
  }});
}

function openDispute(view,row) {
  const record=db.disputas.find(entry=>entry.edital_id===row.id)??{etapa:0,margem_minima:20,alerta:3,resultados:{},historico:[]};
  view.replaceChildren();
  const section=panel(view,'<h2>'+escape(row.numero)+' · '+escape(row.orgao)+'</h2><p>'+disputeStages[record.etapa]+'</p>');
  action('Voltar ao quadro',render,section);
  if(page==='disputa' && client) {
    if(record.etapa<2) writeAction('Configurar farol',()=>disputeRules(view,row,record),section);
    if(record.etapa===0) writeAction('Iniciar disputa',async()=>{await moveDispute(row,record,1);openDispute(view,row);},section,true);
    if(record.etapa===1) writeAction('Enviar para acompanhamento',async()=>{await moveDispute(row,record,2);openDispute(view,row);},section,true);
    if(record.etapa===2) writeAction('Reabrir disputa',async()=>{await moveDispute(row,record,1);openDispute(view,row);},section);
  }
  section.insertAdjacentHTML('beforeend','<p>Margem mínima '+Number(record.margem_minima)+'% · Amarelo até '+(Number(record.margem_minima)+Number(record.alerta))+'% · Verde acima dessa faixa · Vermelho abaixo da mínima</p>');
  const items=disputeItems(row);
  let won=0,wonTotal=0;
  for(const [lot,grouped] of groupProposalItems(items)) {
    if(lot) {
      const floor=grouped.reduce((sum,item)=>sum+bidFloor(unitCost(item),record.margem_minima)*item.quantidade,0);
      section.insertAdjacentHTML('beforeend','<h3>Lote '+escape(lot)+' · Piso total '+money.format(floor)+'</h3>');
    }
    const table=quoteTable(section,['Item','Descrição','Qtd.','Custo unit.','Proposta inicial','Piso unit.','Lance sugerido','Nosso lance','Margem e farol','Liderança','Resultado','Preço vencedor','Total vencedor','Auditoria','Ação']);
    for(const item of grouped) {
      const result=record.resultados[item.id]??{};
      const cost=unitCost(item);
      const floor=bidFloor(cost,record.margem_minima);
      const suggested=bidFloor(cost,result.margem??item.margem);
      const margin=bidMargin(cost,result.lance??suggested);
      const color=margin==null?'':margin+1e-8<record.margem_minima?'Vermelho':margin<=Number(record.margem_minima)+Number(record.alerta)+1e-8?'Amarelo':'Verde';
      const final=result.preco_final==null?null:Math.round(result.preco_final*item.quantidade*100)/100;
      const audit=result.situacao==='Ganhamos'&&result.preco_final<floor?'Ganho abaixo do mínimo':result.situacao==='Perdemos'&&result.preco_final>=floor?'Perdido acima do mínimo':'—';
      if(result.situacao==='Ganhamos') {won++;wonTotal+=final??0;}
      const leader=result.situacao==='Estamos liderando'?'Nossa empresa':[result.concorrente,result.lance_concorrente==null?'':money.format(result.lance_concorrente)].filter(Boolean).join(' · ');
      const outcome=[result.situacao,result.situacao==='Ganhamos'?db.empresas.find(e=>e.id===row.empresa_id)?.nome:result.vencedor,result.marca_vencedora,result.observacao].filter(Boolean).join(' · ');
      const tr=table.insertRow();
      for(const value of [item.codigo,printedDescription(item),item.quantidade,money.format(cost),money.format(price(item)),money.format(floor),money.format(suggested),result.lance==null?'—':money.format(result.lance)]) tr.insertCell().textContent=value;
      const signal=tr.insertCell();
      signal.textContent=color?color+' · '+margin.toFixed(2)+'%':'—';
      if(color) signal.style.backgroundColor={Vermelho:'#fee2e2',Amarelo:'#fef3c7',Verde:'#dcfce7'}[color];
      for(const value of [leader||'—',outcome||'Sem resultado',result.preco_final==null?'—':money.format(result.preco_final),final==null?'—':money.format(final),audit]) tr.insertCell().textContent=value;
      const cell=tr.insertCell();
      if(page==='disputa' && record.etapa===1) writeAction('Lance e resultado',()=>editDisputeItem(view,row,record,item),cell);
    }
  }
  section.insertAdjacentHTML('beforeend','<p><strong>Itens ganhos: '+won+' · Total ganho: '+money.format(wonTotal)+'</strong></p>');
  if(record.historico.length) {
    const history=panel(view,'<h3>Histórico de movimentações</h3>');
    const list=document.createElement('ul');
    list.style.cssText='font-size:9pt;margin:4px 0';
    for(const entry of [...record.historico].reverse()) {
      const li=document.createElement('li');
      li.textContent=disputeStages[entry.origem]+' → '+disputeStages[entry.destino]+' · '+entry.usuario+' · '+quoteDate.format(new Date(entry.data));
      list.append(li);
    }
    history.append(list);
  }
}

function renderDisputes(view) {
  if(unavailableRegistries.has('disputas')) {
    panel(view,'<p>O quadro de disputa aguarda a atualização do banco de dados.</p>');
    return;
  }
  const follow=page==='acompanhamento';
  const grid=document.createElement('section');
  grid.style.cssText=follow?'':'display:grid;grid-template-columns:repeat(3,minmax(210px,1fr));gap:12px;overflow:auto';
  const rows=db.editais.filter(row=>(row.status==='Aprovado'&&proposalStage(row)===5)||db.disputas.some(d=>d.edital_id===row.id));
  const recordFor=row=>db.disputas.find(entry=>entry.edital_id===row.id)??{etapa:0,resultados:{}};
  for(const [index,stage] of disputeStages.entries()) {
    if(follow && index!==2) continue;
    const entries=rows.filter(row=>recordFor(row).etapa===index);
    const lane=document.createElement('section');
    lane.className='lane';
    lane.innerHTML='<h3>'+stage+' · '+entries.length+'</h3>';
    if(!follow && client && canWrite()) {
      lane.ondragover=event=>event.preventDefault();
      lane.ondrop=event=>{
        event.preventDefault();
        const row=rows.find(entry=>entry.id===event.dataTransfer.getData('text/plain'));
        if(row && recordFor(row).etapa!==index) moveDispute(row,recordFor(row),index).then(render).catch(error=>message(error.message));
      };
    }
    for(const row of entries) {
      const card=panel(lane,'<strong>'+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p>');
      card.classList.add('card');
      card.draggable=!follow && !!client && canWrite();
      card.ondragstart=event=>event.dataTransfer.setData('text/plain',row.id);
      action(follow?'Ver resultado':'Abrir disputa',()=>openDispute(view,row),card);
    }
    grid.append(lane);
  }
  view.append(grid);
}

function renderProposalBoard(view) {
  const grid = document.createElement('section');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(6,minmax(210px,1fr));gap:12px;overflow:auto';
  const approved = db.editais.filter(row=>row.status==='Aprovado');
  for (const [index,stage] of proposalStages.entries()) {
    const rows = approved.filter(row=>proposalStage(row)===index);
    const lane = document.createElement('section');
    lane.className = 'lane';
    lane.innerHTML = '<h3>'+stage+' · '+rows.length+'</h3>';
    if (client && canWrite()) {
      lane.ondragover = event=>event.preventDefault();
      lane.ondrop = event=>{
        event.preventDefault();
        const row = approved.find(row=>row.id===event.dataTransfer.getData('text/plain'));
        if (row) moveProposal(row,index).catch(error=>message(error.message));
      };
    }
    for (const row of rows) {
      const card = panel(lane,'<strong>'+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p><p>'+money.format(total(db.itens.filter(item=>item.edital_id===row.id)))+'</p>');
      card.classList.add('card');
      card.draggable = Boolean(client && canWrite());
      card.ondragstart = event=>event.dataTransfer.setData('text/plain',row.id);
      action('Abrir proposta',()=>openWorkflowProposal(row),card);
    }
    grid.append(lane);
  }
  view.append(grid);
}

function openWorkflowProposal(row) {
  activeEdital = row.id;
  detailMode = 'proposal';
  render();
}

function renderReadyProposals(view) {
  const section = panel(view,'<h2>Propostas prontas para disputa</h2>');
  const rows = db.editais.filter(row=>row.status==='Aprovado' && proposalStage(row)===5);
  if (!rows.length) section.append('Nenhuma proposta nesta etapa.');
  for (const row of rows) {
    const card = panel(section,'<strong>'+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p>');
    action('Abrir proposta e baixar ZIP',()=>openWorkflowProposal(row),card);
  }
}

const iconPaths = {
  painel:'M3 10l9-7 9 7v10h-6v-6H9v6H3z', editais:'M3 4h18v16H3z M9 4v12 M15 4v9',
  propostas:'M5 3h10l4 4v14H5z M8 12h8 M8 16h8',
  documentacao:'M3 7h7l2 2h9v11H3z M9 14l2 2 4-4',
  empresas:'M3 21V9l9-6 9 6v12 M8 21v-7h8v7',
  orgaos:'M3 9l9-6 9 6z M5 10v9 M10 10v9 M14 10v9 M19 10v9 M3 21h18',
  catalogo:'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  configuracoes:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  relatorios:'M4 3h16v18H4z M8 17v-4 M12 17V7 M16 17v-7',
  ajuda:'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4 M12 17h.01',
  equipe:'M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2 M16 15a4 4 0 014 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z',
  clientes:'M12 22s8-4 8-12V5l-8-3-8 3v5c0 8 8 12 8 12z',
  sair:'M10 4H4v16h6 M8 12h13 M17 8l4 4-4 4',
  plus:'M12 5v14 M5 12h14', arrow:'M4 12h16 M15 7l5 5-5 5'
};
function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name]}"/></svg>`;
}
function goTo(key) {
  page = key;
  activeEdital = null;
  message('');
  render();
}
function navAction(key,label,run,parent) {
  const button = action(label,run,parent);
  button.insertAdjacentHTML('afterbegin',icon(iconPaths[key] ? key : 'propostas'));
  button.setAttribute('aria-current',String(key === page || (key === 'painel' && page === 'relatorios')));
}
function renderOverview(view) {
  const editais = db.editais;
  const count = status => editais.filter(row => row.status === status).length;
  const publishedProposals = new Set(db.itens.map(item => item.edital_id)).size;
  const overview = document.createElement('section');
  overview.className = 'overview-banner';
  overview.innerHTML = `<div><span class="eyebrow">OPERAÇÃO DE LICITAÇÕES</span>
    <h2>Editais e propostas,<br>na mesma direção.</h2>
    <p>Acompanhe oportunidades, organize a documentação e prepare suas propostas.</p>
    <div class="hero-buttons"></div></div>
    <div class="banner-side">${[
      ['Editais captados',count('Captado')],['Editais em análise',count('Em análise')],
      ['Editais aprovados',count('Aprovado')],['Propostas com itens',publishedProposals]
    ].map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>`;
  const controls = overview.querySelector('.hero-buttons');
  const board = action('Abrir quadro de captação',()=>goTo('editais'),controls);
  board.className = 'accent';
  board.insertAdjacentHTML('beforeend',icon('arrow'));
  action('Ver propostas',()=>goTo('propostas'),controls).className = 'outline-light';
  action('Ver relatórios',()=>goTo('relatorios'),controls).className = 'outline-light';
  view.append(overview);
  const grid = document.createElement('section');
  grid.className = 'grid overview-metrics';
  for (const [label,value,detail,symbol] of [
    ['Oportunidades cadastradas',editais.length,'Todos os editais da empresa','editais'],
    ['Valor em propostas',money.format(total(db.itens)),'Soma dos itens cadastrados','propostas'],
    ['CNPJs cadastrados',db.empresas.length,'Empresas e estabelecimentos','empresas']
  ]) {
    grid.insertAdjacentHTML('beforeend',`<div class="metric"><div><span>${label}</span><span class="metric-icon">${icon(symbol)}</span></div><strong>${escape(value)}</strong><small>${detail}</small></div>`);
  }
  view.append(grid);
}

function renderReports(view) {
  const report = panel(view,'<h2>Editais por data da sessão</h2><form class="line"><label>De<input name="from" type="date"></label><label>Até<input name="to" type="date"></label><label>Situação<select name="status"></select></label><button type="submit" class="primary">Filtrar</button></form><p role="alert"></p><div class="scroll"></div>');
  const form = report.querySelector('form');
  const status = form.elements.namedItem('status');
  status.add(new Option('Todas',''));
  stages.forEach(stage => status.add(new Option(stage)));
  const results = report.querySelector('.scroll');
  const alert = report.querySelector('[role=alert]');
  const totals = new Map();
  for (const item of db.itens) {
    totals.set(item.edital_id,(totals.get(item.edital_id) ?? 0) + Math.round(price(item)*item.quantidade*100));
  }
  function draw() {
    const {from,to,status} = Object.fromEntries(new FormData(form));
    if (from && to && from > to) {
      alert.textContent = 'A data inicial deve ser anterior ou igual à final.';
      results.replaceChildren();
      return;
    }
    alert.textContent = '';
    const rows = db.editais.filter(row => (!status || row.status === status)
      && (!from || (row.sessao && row.sessao >= from))
      && (!to || (row.sessao && row.sessao <= to)));
    const value = rows.reduce((sum,row) => sum + (totals.get(row.id) ?? 0),0);
    results.innerHTML = `<p><strong>${rows.length}</strong> edital(is) · <strong>${money.format(value/100)}</strong> em propostas</p>`;
    if (!rows.length) {
      results.insertAdjacentHTML('beforeend','<p>Nenhum edital encontrado.</p>');
      return;
    }
    results.insertAdjacentHTML('beforeend',`<table><thead><tr><th>Processo</th><th>Órgão</th><th>Sessão</th><th>Situação</th><th>Valor da proposta</th></tr></thead><tbody>${rows.map(row => {
      const date = row.sessao ? row.sessao.split('-').reverse().join('/') : 'A definir';
      return '<tr>'+[row.numero,row.orgao,date,row.status,totals.has(row.id) ? money.format(totals.get(row.id)/100) : '—'].map(value=>'<td>'+escape(value)+'</td>').join('')+'</tr>';
    }).join('')}</tbody></table>`);
  }
  form.onsubmit = event => { event.preventDefault(); draw(); };
  draw();
}

function renderHelp(view) {
  const articles = [
    ['configuracoes','Onde cadastrar o CNPJ participante?','Em Configurações, abra CNPJs participantes e informe a razão social, o CNPJ e o enquadramento.'],
    ['editais','Como aprovar uma oportunidade?','Abra a oportunidade em Captação, selecione o CNPJ participante e registre o parecer da equipe.'],
    ['propostas','Como montar a proposta?','Abra um edital aprovado em Propostas e informe os itens, as quantidades, os custos e as margens.'],
    ['documentacao','Como conferir os documentos?','Abra o checklist do edital em Documentação, registre as validades e marque os requisitos conferidos.'],
    ['relatorios','Como acompanhar valores e prazos?','Em Relatórios, filtre os editais pela data da sessão e pela situação.']
  ];
  const section = panel(view,'<label>Buscar no manual<input type="search" placeholder="Ex.: CNPJ ou proposta"></label><p role="status"></p><div></div>');
  const search = section.querySelector('input');
  const results = section.lastElementChild;
  const status = section.querySelector('[role=status]');
  const normalize = value => value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
  function draw() {
    const query = normalize(search.value.trim());
    const matches = articles.filter(([,title,body]) => normalize(title+' '+body).includes(query));
    results.replaceChildren();
    status.textContent = matches.length ? '' : 'Nenhuma orientação encontrada.';
    for (const [route,title,body] of matches) {
      const detail = document.createElement('details');
      detail.className = 'card';
      detail.innerHTML = `<summary>${title}</summary><p>${body}</p>`;
      action('Abrir '+(screens[route] ?? 'Relatórios'),()=>goTo(route),detail);
      results.append(detail);
    }
  }
  search.oninput = draw;
  draw();
}

function render() {
  const nav = byId('nav');
  const view = byId('view');
  const account = byId('account');
  for (const node of [nav,view,account,byId("page-actions")]) node.replaceChildren();
  const platformView = master && page === 'clientes';
  const customer = groups.find(entry => entry.id === group);
  byId('page-title').textContent = platformView ? 'Administração da plataforma'
    : session || !client ? (page === 'equipe' ? 'Minha equipe' : page === 'relatorios' ? 'Relatórios' : screens[page] ?? 'Painel geral')
    : 'Acesso ao sistema';
  byId('connection').textContent = !client ? 'Modo demonstração · dados salvos somente neste navegador'
    : platformView ? 'E-Lementar · desenvolvedora da plataforma'
    : customer ? 'Área da empresa · ' + customer.nome
    : session ? 'Área da empresa' : 'Gestão de licitações e compras governamentais';
  byId('breadcrumb-label').textContent = byId('page-title').textContent;
  byId('workspace-name').textContent = customer?.nome?.toLocaleUpperCase('pt-BR') || 'E-LEMENTAR LICITAÇÕES';
  if (page === 'painel' && (!client || group)) {
    byId('page-title').textContent = 'Clareza para decidir. Controle para crescer.';
    if (client) byId('connection').textContent = 'Sua empresa em movimento, da captação à entrega.';
    if (canWrite()) action('Nova oportunidade',()=>edital(),byId('page-actions'),true).insertAdjacentHTML('afterbegin',icon('plus'));
  }
  if (client && !session) {
    const access = document.createElement('div');
    access.className = 'auth-layout';
    access.innerHTML = '<section class="auth-intro"><strong>E-Lementar Licitações</strong><h2>Da oportunidade à entrega.</h2><p>Organize editais, propostas e fornecimentos ao poder público.</p></section><section class="auth-access"><h2>Acesse sua empresa</h2><form id="login-form"><label>E-mail<input name="email" type="email" autocomplete="username" required></label><label>Senha<input name="password" type="password" autocomplete="current-password" required></label><button type="submit" class="primary">Entrar</button><p role="alert"></p></form></section>';
    view.append(access);
    const form = byId('login-form');
    form.onsubmit = async event => {
      event.preventDefault();
      const button = event.submitter;
      const errorBox = form.querySelector('[role=alert]');
      button.disabled = true;
      errorBox.textContent = '';
      try {
        const credentials = Object.fromEntries(new FormData(form));
        const {data,error} = await client.auth.signInWithPassword(credentials);
        if (error) throw error;
        session = data.session;
        form.reset();
        try { await loadGroups(); }
        catch (loadError) { message(loadError.message); }
        render();
      } catch (error) {
        errorBox.textContent = error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : error.message;
      } finally { button.disabled = false; }
    };
    return;
  }
  if (client) {
    const user = session.user.user_metadata?.username || session.user.email?.split('@')[0] || 'Meu acesso';
    const profile = master ? 'Mestre Criador' : ({admin:'Administrador',operador:'Operador',leitor:'Leitor'}[groupRole()] || 'Usuário');
    account.innerHTML = `<span class="avatar" aria-hidden="true">${escape(user.slice(0,2).toUpperCase())}</span><div><strong>${escape(user)}</strong><small>${profile}</small></div>`;
    const signout = action('Sair', async () => {
      const {error} = await client.auth.signOut();
      if (error) throw error;
      session = null; group = null; master = false; groups = []; clients = []; team = []; page = 'painel'; activeEdital = null; await load(); render();
    },account);
    signout.className = 'signout';
    signout.setAttribute('aria-label','Sair');
    signout.title = 'Sair';
    signout.innerHTML = icon('sair');
    if (master) navAction('clientes','Mestre Gerenciador',openClients,nav);
    if (!groups.length) {
      if (page === 'clientes' && master) renderClients(view);
      else panel(view,'<p>Seu usuário ainda está sem vínculo com uma empresa.</p>');
      return;
    }

    const select = document.createElement('select');
    select.setAttribute('aria-label','Empresa cliente');
    groups.forEach(g => select.add(new Option(g.nome,g.id)));
    select.value = group;
    select.onchange = async () => {
      const previous = group;
      group = select.value; activeEdital = null; page = 'painel';
      try { await load(); render(); }
      catch(error) { group = previous; select.value = previous; message(error.message); }
    };
    nav.append(select);
  }
  for (const [key,label] of Object.entries(screens)) {
    navAction(key,label,()=>goTo(key),nav);
  }
  if (groupRole() === 'admin') navAction('equipe','Minha equipe',openTeam,nav);
  if (page === 'clientes' && master) { renderClients(view); return; }
  if (page === 'equipe' && groupRole() === 'admin') { renderTeam(view); return; }
  if (activeEdital) { renderProposal(view,db.editais.find(x => x.id === activeEdital)); return; }
  if (page === 'disputa' || page === 'acompanhamento') { renderDisputes(view); return; }
  if (page === 'cotacoes' || page === 'orcamento') { renderQuotes(view); return; }
  if (page === 'financeiro') { renderQuoteFinance(view); return; }
  if (page === 'propostas') { renderProposalBoard(view); return; }
  if (page === 'propostaPronta') { renderReadyProposals(view); return; }
  if (page === 'documentacao') { renderAcervo(view).catch(error=>message(error.message)); return; }
  if (page === 'relatorios') { renderReports(view); return; }
  if (page === 'orgaos' || page === 'catalogo') { renderRegistry(view,page === 'orgaos'); return; }
  if (page === 'ajuda') { renderHelp(view); return; }
  if (Object.hasOwn(pendingScreens,page)) {
    panel(view,'<h2>Em implantação</h2><p>'+escape(pendingScreens[page])+'</p>');
    return;
  }
  if (page === 'painel') {
    renderOverview(view);
  } else if (page === 'configuracoes') {
    const section = panel(view,'<h2>CNPJs participantes</h2><p>Cadastre os CNPJs que sua empresa usa para participar de licitações. Eles ficam disponíveis para seleção no edital.</p>');
    writeAction('Cadastrar CNPJ',company,section,true);
    if (!db.empresas.length) section.insertAdjacentHTML('beforeend','<p class="muted">Nenhum CNPJ cadastrado.</p>');
    for (const e of db.empresas) {
      const company = panel(section,'<strong>'+escape(e.nome)+'</strong><p>'+escape(e.cnpj)+' · '+escape(e.porte)+'</p>');
      writeAction('Logo e dados para propostas',()=>companyProposalSettings(e),company);
    }
  } else {
    writeAction('Nova oportunidade',()=>edital(),view,true);
    const grid = document.createElement('div');
    grid.className = 'grid'; grid.style.marginTop='14px';
    view.append(grid);
    for (const stage of stages) {
      const lane = document.createElement('section');
      lane.className = 'lane';
      const rows = db.editais.filter(row => row.status===stage);
      lane.innerHTML = '<h3>'+escape(stage)+' · '+rows.length+'</h3>';
      grid.append(lane);
      for (const row of rows) {
        const card = panel(lane,'<strong>Processo '+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p><p class="muted">'+escape(row.modalidade)+(row.numero_pregao?' · Nº '+escape(row.numero_pregao):'')+'</p>');
        card.classList.add('card');
        writeAction('Analisar',()=>edital(row),card);
        if (row.local_disputa) card.insertAdjacentHTML('beforeend','<p>Disputa: '+escape(row.local_disputa)+'</p>');
        const editalUrl = safeWebUrl(row.edital_url);
        if (editalUrl) card.insertAdjacentHTML('beforeend','<p><a href="'+escape(editalUrl)+'" target="_blank" rel="noopener noreferrer">Abrir publicação do edital</a></p>');
        if (row.edital_pdf_nome) action('Baixar edital',()=>downloadEdital(row),card);
        if (row.status==='Aprovado' || db.itens.some(x=>x.edital_id===row.id)) action('Abrir proposta',()=>{detailMode=null;activeEdital=row.id;render();},card,true);
      }
    }
  }
}

function documentExpired(file) {
  const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
  return Boolean(file.validade && file.validade<today);
}

function documentValidity(file) {
  if (!file.validade) return 'Validade não informada';
  return (documentExpired(file)?'Vencido em ':'Válido até ')+file.validade.split('-').reverse().join('/');
}

async function renderAcervo(view) {
  const section = panel(view,'<h2>Acervo de documentos da empresa</h2>');
  if (!client || !db.empresas.length) { section.append('Cadastre um CNPJ participante para criar o acervo.'); return; }
  const select = document.createElement('select');
  select.setAttribute('aria-label','Empresa do documento');
  for (const empresa of db.empresas) select.add(new Option(empresa.nome+' · '+empresa.cnpj,empresa.id));
  section.append(select);
  const list = document.createElement('div');
  section.append(list);
  async function draw() {
    const company = select.value;
    const scope = {grupo_id:group,empresa_id:company};
    const {data,error} = await client.from('arquivos_empresa').select('id,nome,validade').match(scope).order('nome');
    if (error) throw error;
    if (!section.isConnected || select.value!==company) return;
    list.replaceChildren();
    writeAction('Cadastrar documento',()=>edit('Cadastrar documento',[['nome','Nome do documento','text'],['validade','Validade','date'],['arquivo','PDF','file']],async values=>{
      const {error} = await client.from('arquivos_empresa').insert({...scope,nome:values.nome.trim(),validade:values.validade||null,conteudo:await encodePdf(values.arquivo)});
      if (error) throw error;
    },{onSaved:()=>draw().catch(error=>message(error.message))}),list,true);
    if (!data.length) list.append('Nenhum documento cadastrado.');
    for (const file of data) {
      const card = panel(list,'<strong>'+escape(file.nome)+'</strong><p>'+escape(documentValidity(file))+'</p>');
      action('Baixar PDF',async()=>{
        const {data,error} = await client.from('arquivos_empresa').select('conteudo').match({...scope,id:file.id}).single();
        if (error) throw error;
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(data.conteudo),c=>c.charCodeAt(0))],{type:'application/pdf'}));
        const link = document.createElement('a');
        link.href=url;
        link.download=file.nome.replace(/\.pdf$/i,'')+'.pdf';
        link.click();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
      },card);
      writeAction('Editar validade',()=>edit('Editar validade',[['validade','Validade','date',file.validade]],async values=>{
        const {error}=await client.from('arquivos_empresa').update({validade:values.validade||null}).match({...scope,id:file.id});
        if (error) throw error;
      },{onSaved:()=>draw().catch(error=>message(error.message))}),card);
    }
  }
  select.onchange = ()=>draw().catch(error=>message(error.message));
  await draw();
}

async function renderProposalHistory(view,row) {
  const section = panel(view,'<h2>Histórico de movimentações</h2>');
  if (!client) return;
  const {data,error} = await client.from('historico_proposta').select('origem,destino,responsavel,ocorrido_em')
    .match({grupo_id:group,edital_id:row.id}).order('id',{ascending:false});
  if (error) throw error;
  if (!section.isConnected) return;
  if (!data.length) section.append('Nenhuma movimentação registrada.');
  const date = new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'medium',timeZone:'America/Sao_Paulo'});
  const list = document.createElement('ul');
  list.style.cssText = 'list-style:none;margin:4px 0 0;padding:0;font-size:9pt;line-height:1.3';
  for (const entry of data) {
    const item = document.createElement('li');
    item.style.cssText = 'padding:3px 0;border-bottom:1px solid #e5e7eb;overflow-wrap:anywhere';
    item.innerHTML = '<strong>'+proposalStages[entry.origem]+' → '+proposalStages[entry.destino]+'</strong> · '+escape(entry.responsavel)+' · '+date.format(new Date(entry.ocorrido_em))+' (Brasília)';
    list.append(item);
  }
  section.append(list);
}

async function downloadProposalPackage(row,scope,selected) {
  const {data,error} = await client.from('arquivos_empresa').select('id,nome,conteudo,validade')
    .match({grupo_id:scope.grupo_id,empresa_id:scope.empresa_id}).in('id',[...selected]);
  if (error) throw error;
  if (data.length !== selected.size) throw new Error('Um arquivo vinculado ficou indisponível.');
  if (data.some(documentExpired)) throw new Error('Há documentos vencidos. Volte para Vincular documentação e atualize a seleção.');
  const signed = await readSignedProposal(row);
  const files = data.map((file,index)=>({name:'documentos/'+(index+1)+'-'+(file.nome.replace(/\.pdf$/i,'')+'.pdf').replace(/[^\p{L}\p{N} ._-]/gu,'_'),bytes:Uint8Array.from(atob(file.conteudo),character=>character.charCodeAt(0))}));
  const zip = makeZip([{name:'proposta-inicial-assinada.pdf',bytes:pdfBytes(signed)},...files]);
  const url = URL.createObjectURL(zip);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'proposta-'+row.numero.replace(/[^a-z0-9_-]/gi,'-')+'.zip';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

async function proposalAttachments(section,row,items) {
  if (!row.empresa_id || !client) return;
  const scope = {grupo_id:group,empresa_id:row.empresa_id,edital_id:row.id};
  const [files,links] = await Promise.all([
    client.from('arquivos_empresa').select('id,nome,validade').match({grupo_id:scope.grupo_id,empresa_id:scope.empresa_id}),
    client.from('anexos_proposta').select('arquivo_id').match(scope)
  ]);
  if (!section.isConnected) return;
  if (files.error || links.error) {
    const error = files.error || links.error;
    if (['PGRST205','42P01'].includes(error.code)) {
      section.append('O envio de arquivos aguarda a atualização do banco de dados.');
      return;
    }
    throw error;
  }
  const selected = new Set(links.data.map(link=>link.arquivo_id));
  const list = panel(section,'<h3>Arquivos do CNPJ participante</h3>');
  if (!files.data.length) list.append('Nenhum arquivo cadastrado.');
  for (const file of files.data) {
    const linked = selected.has(file.id);
    const card = panel(list,'<strong>'+escape(file.nome)+'</strong><p>'+escape(documentValidity(file))+' · '+(linked?'Anexado à proposta':'Disponível para anexar')+'</p>');
    if (proposalStage(row)<3 && (linked || !documentExpired(file))) writeAction(linked?'Desvincular':'Anexar à proposta',async()=>{
      const values = {...scope,arquivo_id:file.id};
      const {error} = await (linked
        ? client.from('anexos_proposta').delete().match(values)
        : client.from('anexos_proposta').upsert(values,{ignoreDuplicates:true}));
      if (error) throw error;
      if (section.isConnected) render();
    },card);
  }
  if (proposalStage(row)===5 && items.length && selected.size) {
    action('Baixar ZIP da proposta',()=>downloadProposalPackage(row,scope,selected),section,true);
  }
}

const printedDescription = item=>item.usar_descricao_interna ? item.descricao_interna || item.descricao : item.descricao;
const proposalIdentity = [
  ['inscricao_estadual','Inscrição estadual'],['endereco','Endereço'],['telefone','Telefone / Fax'],['email','E-mail'],
  ['banco','Banco'],['agencia','Agência'],['conta','Conta'],['signatario','Nome do signatário'],
  ['cargo','Cargo'],['nacionalidade','Nacionalidade'],['rg','Identidade'],['cpf','CPF próprio para a proposta']
];
function companyProposalSettings(company) {
  const current = company.dados_proposta ?? {};
  edit('Dados da empresa para impressão',[
    ...proposalIdentity.map(([key,label])=>[key,label,'text',current[key]]),
    ['logo','Logomarca da empresa','file']
  ],async values=>{
    const {logo,...details}=values;
    const dados_proposta = {...current,...details};
    if (logo.size) {
      if (logo.size>1024*1024 || !['image/png','image/jpeg'].includes(logo.type)) throw new Error('Use uma logomarca PNG ou JPG de até 1 MB.');
      dados_proposta.logo = await new Promise((resolve,reject)=>{
        const reader = new FileReader();
        reader.onload = ()=>resolve(reader.result);
        reader.onerror = ()=>reject(reader.error);
        reader.readAsDataURL(logo);
      });
    }
    await save('empresas',{dados_proposta},company.id);
  },{decorate:form=>form.querySelectorAll('input').forEach(field=>field.required=false)});
}

function groupProposalItems(items) {
  const groups = new Map();
  for (const item of items) {
    const lot = item.lote ?? '';
    if (!groups.has(lot)) groups.set(lot,[]);
    groups.get(lot).push(item);
  }
  return groups;
}

let pdfLibrary;
async function proposalPdfLibrary() {
  pdfLibrary ??= new Promise((resolve,reject)=>{
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';
    script.onload = ()=>window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('Gerador de PDF indisponível.'));
    script.onerror = ()=>{ script.remove(); reject(new Error('Não foi possível carregar o gerador de PDF.')); };
    document.head.append(script);
  }).catch(error=>{ pdfLibrary = undefined; throw error; });
  return pdfLibrary;
}

async function downloadProposalPdf(row,items,{budget=false}={}) {
  const Pdf = await proposalPdfLibrary();
  const pdf = new Pdf({unit:'mm',format:'a4'});
  const company = db.empresas.find(entry=>entry.id===row.empresa_id);
  const identity = company?.dados_proposta ?? {};
  let y = 16;
  function space(height) {
    if (y+height>277) { pdf.addPage(); y=16; }
  }
  function write(value,{size=10,bold=false}={}) {
    pdf.setFont('helvetica',bold?'bold':'normal');
    pdf.setFontSize(size);
    const step = size*0.46;
    for (const text of pdf.splitTextToSize(String(value??''),178)) {
      space(step);
      pdf.text(text,16,y);
      y+=step;
    }
  }
  if (/^data:image\/(png|jpeg);base64,/.test(identity.logo??'')) {
    const image = pdf.getImageProperties(identity.logo);
    const scale = Math.min(55/image.width,22/image.height);
    pdf.addImage(identity.logo,image.fileType,16,y,image.width*scale,image.height*scale);
    y+=image.height*scale+5;
  }
  write(budget?'ORÇAMENTO COMERCIAL':'PROPOSTA COMERCIAL',{size:17,bold:true});
  write('Razão social: '+(company?.nome??''),{bold:true});
  write('CNPJ: '+(company?.cnpj??''));
  for (const [key,label] of proposalIdentity) if (identity[key]) write(label+': '+identity[key]);
  y+=3;
  write('À atenção do Setor de Licitações — '+row.orgao);
  write(budget?'Referência da solicitação: '+row.numero:'Processo: '+row.numero+' · '+row.modalidade+' '+(row.numero_pregao??''));
  if (row.sessao) write('Data da sessão: '+row.sessao.split('-').reverse().join('/'));
  if (row.local_disputa) write('Local ou portal da disputa: '+row.local_disputa);
  write((budget?'Objeto do orçamento: ':'Objeto: ')+(row.objeto??''));
  if (budget && row.observacao) write(row.observacao);
  for (const [lot,entries] of groupProposalItems(items)) {
    if (lot) { y+=3; write('Lote '+lot,{bold:true}); }
    for (const item of entries) {
      y+=3;
      space(16);
      const code = catalogCode(item);
      write('Item '+item.codigo+(code?' · Código interno '+code:''),{bold:true});
      write(printedDescription(item));
      write([item.quantidade+' '+(item.unidade??''),item.marca,'Unitário: '+money.format(price(item)),'Total: '+money.format(total([item]))].filter(Boolean).join(' · '));
    }
    if (lot) write('Subtotal do lote: '+money.format(total(entries)),{bold:true});
  }
  y+=4;
  write((budget?'Valor total do orçamento: ':'Valor total da proposta: ')+money.format(total(items)),{size:12,bold:true});
  space(35);
  y+=16;
  pdf.line(16,y,103,y);
  y+=5;
  write(identity.signatario || company?.nome || 'Representante da empresa participante',{bold:true});
  if (identity.cargo) write(identity.cargo);
  write('Assinatura do representante');
  for (let page=1;page<=pdf.getNumberOfPages();page++) {
    pdf.setPage(page);
    pdf.setFont('helvetica','normal');
    pdf.setFontSize(7);
    pdf.setTextColor(115);
    pdf.text('Gerado pelo E-Lementar Licitações',194,289,{align:'right'});
  }
  pdf.save((budget?'orcamento-':'proposta-')+row.numero.replace(/[^a-z0-9_-]/gi,'-')+'.pdf');
}

const pdfBytes = base64=>Uint8Array.from(atob(base64),character=>character.charCodeAt(0));

async function readSignedProposal(row) {
  const {data,error} = await client.from('propostas_assinadas').select('pdf').match({grupo_id:group,edital_id:row.id}).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Volte à Conferência 02 e anexe o PDF assinado para gerar o ZIP.');
  return data.pdf;
}

async function renderProposalSignature(view,row) {
  const section = panel(view,'<h2>Assinatura da proposta</h2>');
  const {data,error} = await client.from('propostas_assinadas').select('anexado_em').match({grupo_id:group,edital_id:row.id}).maybeSingle();
  if (error) throw error;
  if (!section.isConnected) return;
  section.append(data?'PDF assinado anexado.':'Baixe o PDF da proposta. Assine digitalmente ou imprima, assine e digitalize. Em seguida, anexe o PDF assinado.');
  if (data) action('Baixar PDF assinado',async()=>{
    const url = URL.createObjectURL(new Blob([pdfBytes(await readSignedProposal(row))],{type:'application/pdf'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'proposta-assinada.pdf';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  },section);
  if (proposalStage(row)===4) writeAction(data?'Substituir PDF assinado':'Anexar PDF assinado',()=>edit('Anexar proposta assinada',
    [['arquivo','Proposta assinada em PDF','file']],async ({arquivo})=>{
      const {error} = await client.rpc('anexar_proposta_assinada',{p_edital:row.id,p_pdf:await encodePdf(arquivo)});
      if (error) throw error;
    },{decorate:form=>{form.elements.namedItem('arquivo').accept='.pdf,application/pdf';}}),section,true);
}

const importColumns = ['ITEM','QTD','UND','DESCRICAO_EDITAL','MARCA','CUSTO','MARGEM','FORNECEDOR','OBSERVACAO','CODIGO_CATALOGO','DESCRICAO_NA_PROPOSTA','LOTE'];
const catalogColumns = ['DESCRICAO','TIPO','UNIDADE','MARCA','DETALHES','OBSERVACAO','CUSTO','MARGEM'];
const catalogCode = item=>db.catalogo.find(entry=>entry.id===item.catalogo_id)?.codigo??'';

function importCatalog() {
  edit('Importar catálogo de produtos e serviços',[['planilha','Planilha do catálogo (.xlsx)','file']],async ({planilha})=>{
    if (!/\.xlsx$/i.test(planilha.name) || !planilha.size || planilha.size>2*1024*1024) throw new Error('Selecione uma planilha .xlsx de até 2 MB.');
    const lines = await readExcelItems(planilha);
    if (lines.shift()?.join('|') !== catalogColumns.join('|')) throw new Error('Use os cabeçalhos do modelo do catálogo.');
    const records = [];
    for (const [index,cells] of lines.entries()) {
      if (!cells.some(Boolean)) continue;
      try {
        if (cells.slice(catalogColumns.length).some(Boolean)) throw new Error('Remova as colunas extras.');
        const [descricao,tipo,unidade,marca,detalhes,observacao,custo,margem] = catalogColumns.map((_,column)=>cells[column]??'');
        records.push(catalogValues({descricao,tipo,unidade,marca,detalhes,observacao,custo,margem}));
      } catch(error) { throw new Error('Linha '+(index+2)+': '+error.message); }
    }
    if (!records.length) throw new Error('Inclua pelo menos um produto ou serviço.');
    if (client) {
      const {error} = await client.from('catalogo').insert(records.map(record=>({...record,grupo_id:group})),{defaultToNull:false});
      if (error) throw error;
      await load();
    } else {
      const updated = [...db.catalogo,...records.map(record=>{
        const id = crypto.randomUUID();
        return {...record,id,codigo:'CAT-'+id};
      })];
      localStorage.setItem(localKey,JSON.stringify({...db,catalogo:updated}));
      db.catalogo = updated;
    }
  },{decorate:form=>{form.elements.namedItem('planilha').accept='.xlsx';}});
}
async function readExcelItems(file) {
  if (!globalThis.XLSX) {
    await new Promise((resolve,reject)=>{
      const script = document.createElement('script');
      script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      script.onload = resolve;
      script.onerror = ()=>{script.remove();reject(new Error('O leitor de Excel não carregou. Tente novamente.'));};
      document.head.append(script);
    });
  }
  let book;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error();
    book = XLSX.read(bytes,{sheets:0,sheetRows:1002});
  } catch {
    throw new Error('O arquivo não é uma planilha .xlsx válida. Use o modelo do sistema.');
  }
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new Error('A planilha está vazia.');
  const rows = XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:true,blankrows:true});
  if (rows.length > 1001) throw new Error('Importe até 1.000 itens por planilha.');
  return rows.map(row=>row.map(value=>String(value).trim()));
}

function importProposalItems(row) {
  edit('Importar itens da proposta',[['planilha','Planilha do Excel','file']],async ({planilha})=>{
    if (!planilha.size || planilha.size > 2*1024*1024) throw new Error('Selecione uma planilha de até 2 MB.');
    const isExcel = /\.xlsx$/i.test(planilha.name);
    const lines = isExcel ? await readExcelItems(planilha) : readXmlItems(await planilha.text());
    const header = lines.shift()?.join('|');
    if (header !== importColumns.join('|') && !(row.modo_disputa!=='lote' && header===importColumns.slice(0,-1).join('|'))) throw new Error('Mantenha os nomes e a ordem das colunas do modelo.');
    const seen = new Set();
    const items = [];
    for (const [index,cells] of lines.entries()) {
      if (!cells.some(Boolean)) continue;
      const [codigo,quantidade,unidade,descricao,marca_item,custo_embalagem,margem,fornecedor,observacao_item,catalogCode,source,lote] = importColumns.map((_,column)=>cells[column]??'');
      try {
        if (cells.slice(importColumns.length).some(Boolean)) throw new Error('Remova as colunas extras.');
        const key = JSON.stringify([lote,codigo]);
        if (seen.has(key)) throw new Error('Número de item duplicado na planilha.');
        const product = db.catalogo.find(entry=>entry.codigo===catalogCode);
        if (catalogCode && !product) throw new Error('Código do catálogo não localizado: '+catalogCode);
        const origem_descricao = source.toLowerCase() || 'edital';
        if (!['edital','interna'].includes(origem_descricao)) throw new Error('Use edital ou interna na origem da descrição.');
        items.push(proposalItem(row,{lote,codigo,quantidade,unidade,descricao,marca_item,custo_embalagem,margem,fornecedor,
          observacao_item,embalagem:'1',produto_catalogo:product?.id,origem_descricao}));
        seen.add(key);
      } catch(error) { throw new Error('Linha '+(index+2)+': '+error.message); }
    }
    if (!items.length) throw new Error('Inclua pelo menos um item.');
    if (client) {
      const {error} = await client.from('itens').insert(items.map(item=>({...item,grupo_id:group})));
      if (error) throw error;
      await load();
    } else {
      const updated = [...db.itens,...items.map(item=>({...item,id:crypto.randomUUID()}))];
      localStorage.setItem(localKey,JSON.stringify({...db,itens:updated}));
      db.itens = updated;
    }
  },{decorate:form=>{form.elements.namedItem('planilha').accept='.xlsx,.xml';}});
}

function readXmlItems(text) {
    const xml = new DOMParser().parseFromString(text,'application/xml');
    const ns = 'urn:schemas-microsoft-com:office:spreadsheet';
    const table = xml.getElementsByTagNameNS(ns,'Table')[0];
    if (xml.querySelector('parsererror') || !table) throw new Error('Use o modelo XML de itens.');
    return [...table.getElementsByTagNameNS(ns,'Row')].map(line=>{
      const cells = [];
      for (const cell of line.getElementsByTagNameNS(ns,'Cell')) {
        const index = Number(cell.getAttributeNS(ns,'Index') || cells.length+1);
        if (!Number.isInteger(index) || index<=cells.length || index>importColumns.length) throw new Error('A planilha contém colunas fora do modelo.');
        cells[index-1] = cell.textContent.trim();
      }
      return Array.from({length:importColumns.length},(_,index)=>cells[index]??'');
    });
}

function renderProposal(view,row) {
  const rows = db.itens.filter(x=>x.edital_id===row.id);
  
  const section = panel(view,'<h2>Proposta · '+escape(row.numero)+'</h2><p>'+escape(row.orgao)+' · '+escape(db.empresas.find(e=>e.id===row.empresa_id)?.nome)+'</p><p>Total estimado <strong>'+money.format(total(rows))+'</strong></p>');
  section.insertAdjacentHTML('beforeend','<p>Etapa: <strong>'+proposalStages[proposalStage(row)]+'</strong></p>');
  proposalControls(section,row);
  if (proposalStage(row)>=4 && client) renderProposalSignature(view,row).catch(error=>message(error.message));
  if (row.status==='Aprovado' && proposalStage(row)<3) {
    writeAction('Adicionar item',()=>item(row),section,true);
    writeAction('Importar planilha Excel',()=>importProposalItems(row),section);
    if (canWrite()) section.insertAdjacentHTML('beforeend',' <a href="./modelo-itens-proposta.xlsx" download>Baixar modelo Excel (.xlsx)</a>');
  }
  if (rows.length && row.empresa_id) action('Baixar proposta em PDF',()=>downloadProposalPdf(row,rows),section);
  const table = document.createElement('div');
  table.className = 'scroll';
  table.innerHTML = '<table><thead><tr><th>Lote</th><th>Item</th><th>Código interno</th><th>Descrição</th><th>Qtde.</th><th>Und.</th><th>Marca</th><th>Custo unitário</th><th>Margem</th><th>Fornecedor</th><th>Observação</th><th>Preço proposto</th><th>Total</th><th>Ações</th></tr></thead><tbody></tbody></table>';
  section.append(table);
  for (const entry of rows) {
    const tr = table.querySelector('tbody').insertRow();
    for (const value of [entry.lote,entry.codigo,catalogCode(entry),printedDescription(entry),entry.quantidade,entry.unidade,entry.marca,(entry.custo_embalagem/entry.embalagem).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:4}),entry.margem+'%',entry.fornecedor,entry.observacao,money.format(price(entry)),money.format(total([entry]))]) tr.insertCell().textContent=value;
    const controls=tr.insertCell();
    if(row.status==='Aprovado' && proposalStage(row)<3) writeAction('Editar',()=>item(row,entry),controls);
  }
  const attachments = panel(view,'<h2>Documentos selecionados para disputa</h2>');
  proposalAttachments(attachments,row,rows).catch(error=>{if(attachments.isConnected) message(error.message);});
  renderProposalHistory(view,row).catch(error=>message(error.message));
}

async function loadGroups(){
  const {data,error}=await client.from('membros').select('papel,grupos(id,nome)');
  if(error) throw error;
  groups=data.map(m=>({...m.grupos,role:m.papel}));
  const capability = await client.rpc('licitacoes_eh_mestre');
  if (capability.error && capability.error.code !== 'PGRST202') throw capability.error;
  master = capability.data === true;
  group=groups[0]?.id;
  await load();
}

const versionBanner = byId('version-notice');
let checkingVersion = false;
let availableVersion;
async function checkVersion() {
  if (checkingVersion || availableVersion) return;
  checkingVersion = true;
  try {
    const response = await fetch(new URL('./index.html',import.meta.url),{cache:'no-store'});
    if (!response.ok) return;
    const next = new DOMParser().parseFromString(await response.text(),'text/html').querySelector('#app-entry');
    if (!next) return;
    const version = new URL(next.getAttribute('src'),response.url);
    if (version.href === import.meta.url) return;
    availableVersion = version.searchParams.get('v');
    if (availableVersion) versionBanner.hidden = false;
  } catch {
    // A temporary connection error should leave the current version usable.
  } finally {
    checkingVersion = false;
  }
}
versionBanner.querySelector('button').onclick = () => {
  if (document.querySelector('dialog[open]')) return;
  const url = new URL(location.href);
  url.searchParams.set('v',availableVersion);
  location.replace(url);
};
window.addEventListener('focus',checkVersion);
window.setInterval(checkVersion,60000);
void checkVersion();

try {
  if(client){
    const {data,error}=await client.auth.getSession();
    if(error) throw error;
    session=data.session;
    if(session) await loadGroups();
  } else await load();
  render();
} catch(error) { render(); message(error.message); }
