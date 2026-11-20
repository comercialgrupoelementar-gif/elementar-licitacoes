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
const registryTables = ['orgaos_compradores','catalogo'];
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
  cotacoes:'Solicitações de cotação e revisão de preços para fornecedores, com exportação em PDF e XML.',
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
    ? 'id,grupo_id,empresa_id,numero,numero_pregao,orgao,modalidade,sessao,status,parecer,edital_url,local_disputa,edital_pdf_nome,objeto,modo_disputa'
    : '*').eq('grupo_id',group)));
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

function renderProposalBoard(view) {
  const lanes = {
    'A montar':[], 'Em preparação':[], 'Checklist conferido':[]
  };
  for (const edital of db.editais.filter(row => row.status === 'Aprovado')) {
    const items = db.itens.filter(row => row.edital_id === edital.id);
    const documents = db.documentos.filter(row => row.edital_id === edital.id);
    const stage = !items.length ? 'A montar'
      : documents.length && documents.every(doc => doc.conferido) ? 'Checklist conferido'
      : 'Em preparação';
    lanes[stage].push({edital,items,documents});
  }
  const grid = document.createElement('section');
  grid.className = 'grid';
  for (const [stage,proposals] of Object.entries(lanes)) {
    const lane = document.createElement('section');
    lane.className = 'lane';
    lane.innerHTML = `<h3>${stage} · ${proposals.length}</h3>`;
    for (const {edital,items,documents} of proposals) {
      const card = panel(lane,`<strong>${escape(edital.numero)}</strong><p>${escape(edital.orgao)}</p><p>${money.format(total(items))}</p><p class="muted">${documents.filter(doc=>doc.conferido).length}/${documents.length} documentos conferidos</p>`);
      card.classList.add('card');
      function open(mode) {
        detailMode = mode;
        activeEdital = edital.id;
        render();
      }
      action('Abrir proposta',()=>open('proposal'),card);
      action('Documentação',()=>open('docs'),card);
    }
    grid.append(lane);
  }
  view.append(grid);
}

async function renderReadyProposals(view) {
  const section = panel(view,'<h2>Propostas com documentação conferida</h2>');
  if (!client) {
    section.append('Os anexos estão disponíveis no sistema conectado.');
    return;
  }
  const {data,error} = await client.from('anexos_proposta').select('edital_id').eq('grupo_id',group);
  if (!section.isConnected) return;
  if (error) {
    if (!['PGRST205','42P01'].includes(error.code)) throw error;
    section.append('O pacote de documentos aguarda a atualização do banco de dados.');
    return;
  }
  const linked = new Set(data.map(row=>row.edital_id));
  const ready = db.editais.filter(row=>{
    if (row.status !== 'Aprovado' || !linked.has(row.id)) return false;
    const docs = db.documentos.filter(doc=>doc.edital_id===row.id);
    return docs.length && docs.every(doc=>doc.conferido) && db.itens.some(item=>item.edital_id===row.id);
  });
  if (!ready.length) section.append('Nenhuma proposta com itens, checklist conferido e arquivo anexado.');
  for (const edital of ready) {
    const card = panel(section,'<strong>'+escape(edital.numero)+'</strong><p>'+escape(edital.orgao)+'</p>');
    action('Abrir pacote de envio',()=>{
      activeEdital = edital.id;
      detailMode = 'docs';
      render();
    },card,true);
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
  if (page === 'propostas') { renderProposalBoard(view); return; }
  if (page === 'propostaPronta') { renderReadyProposals(view).catch(error=>message(error.message)); return; }
  if (page === 'documentacao') { renderEditalIndex(view,true); return; }
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
    const card = panel(list,'<strong>'+escape(file.nome)+'</strong><p>'+(linked?'Anexado à proposta':'Disponível para anexar')+'</p>');
    writeAction(linked?'Desvincular':'Anexar à proposta',async()=>{
      const values = {...scope,arquivo_id:file.id};
      const {error} = await (linked
        ? client.from('anexos_proposta').delete().match(values)
        : client.from('anexos_proposta').upsert(values,{ignoreDuplicates:true}));
      if (error) throw error;
      if (section.isConnected) render();
    },card);
  }
  if (canWrite()) {
    section.insertAdjacentHTML('beforeend','<form><label>Adicionar PDF ao CNPJ<input type="file" name="arquivo" accept=".pdf" required></label><button type="submit">Salvar arquivo no cadastro</button><p role="alert"></p></form>');
    const form = section.lastElementChild;
    form.onsubmit = async event => {
      event.preventDefault();
      event.submitter.disabled = true;
      const alert = form.querySelector('[role=alert]');
      alert.textContent = '';
      try {
        const file = new FormData(form).get('arquivo');
        if (!file.size || file.size > 5*1024*1024 || await file.slice(0,5).text() !== '%PDF-') {
          throw new Error('Escolha um PDF válido de até 5 MB.');
        }
        const encoded = await new Promise((resolve,reject)=>{
          const reader = new FileReader();
          reader.onload = ()=>resolve(reader.result.split(',')[1]);
          reader.onerror = ()=>reject(reader.error);
          reader.readAsDataURL(file);
        });
        const {error} = await client.from('arquivos_empresa').insert({
          grupo_id:scope.grupo_id,empresa_id:scope.empresa_id,nome:file.name,conteudo:encoded
        });
        if (error) throw error;
        if (section.isConnected) render();
      } catch(error) { alert.textContent = error.message; }
      finally { event.submitter.disabled = false; }
    };
  }
  const checklist = db.documentos.filter(doc=>doc.edital_id===row.id);
  if (items.length && selected.size && checklist.length && checklist.every(doc=>doc.conferido)) {
    action('Baixar ZIP da proposta',async()=>{
      const {data,error} = await client.from('arquivos_empresa').select('id,nome,conteudo')
        .match({grupo_id:scope.grupo_id,empresa_id:scope.empresa_id}).in('id',[...selected]);
      if (error) throw error;
      if (data.length !== selected.size) throw new Error('Um arquivo vinculado ficou indisponível.');
      const empresa = db.empresas.find(entry=>entry.id===row.empresa_id);
      const html = proposalHtml(row,items,empresa);
      const files = data.map((file,index)=>({name:'documentos/'+(index+1)+'-'+file.nome.replace(/[^\p{L}\p{N} ._-]/gu,'_'),bytes:Uint8Array.from(atob(file.conteudo),character=>character.charCodeAt(0))}));
      const zip = makeZip([{name:'proposta-inicial.html',bytes:new TextEncoder().encode(html)},...files]);
      const url = URL.createObjectURL(zip);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'proposta-'+row.numero.replace(/[^a-z0-9_-]/gi,'-')+'.zip';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
    },section,true);
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

function proposalHtml(row,items,empresa) {
  const data = empresa?.dados_proposta ?? {};
  const logo = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(data.logo??'') ? '<img alt="Logomarca da empresa" src="'+escape(data.logo)+'">' : '';
  const identity = proposalIdentity.filter(([key])=>data[key]).map(([key,label])=>'<div><b>'+label+'</b> '+escape(data[key])+'</div>').join('');
  return `<!doctype html><html lang="pt-BR"><meta charset="UTF-8"><title>Proposta comercial</title>
  <style>body{font:13px system-ui;color:#202124;margin:32px}img{max-width:180px;max-height:90px}h1{font-size:20px}p{white-space:pre-wrap}table{width:100%;border-collapse:collapse}th,td{padding:7px;border:1px solid #aaa;text-align:left}thead{display:table-header-group}tr{break-inside:avoid}.identidade{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px}footer{font-size:8px;color:#777;text-align:right;margin-top:24px}@media print{body{margin:0}}</style>
  ${logo}<h1>PROPOSTA COMERCIAL</h1><div class="identidade"><div><b>Razão social</b> ${escape(empresa?.nome)}</div><div><b>CNPJ</b> ${escape(empresa?.cnpj)}</div>${identity}</div>
  <p>À atenção do Setor de Licitações — ${escape(row.orgao)}</p>
  <p><b>Processo</b> ${escape(row.numero)} · ${escape(row.modalidade)} ${escape(row.numero_pregao??'')}</p>
  ${row.sessao?'<p><b>Data da sessão</b> '+escape(row.sessao.split('-').reverse().join('/'))+'</p>':''}
  ${row.local_disputa?'<p><b>Local ou portal da disputa</b> '+escape(row.local_disputa)+'</p>':''}
  <p><b>Objeto</b> ${escape(row.objeto)}</p>
  ${[...groupProposalItems(items)].map(([lot,group])=>`<table><thead><tr><th>Lote</th><th>Item</th><th>Código interno</th><th>Qtde.</th><th>Und.</th><th>Descrição do material ou serviço</th><th>Marca</th><th>Valor unit.</th><th>Valor total</th></tr></thead><tbody>${group.map(item=>'<tr>'+[item.lote,item.codigo,catalogCode(item),item.quantidade,item.unidade,printedDescription(item),item.marca,money.format(price(item)),money.format(total([item]))].map(value=>'<td>'+escape(value)+'</td>').join('')+'</tr>').join('')}</tbody></table>${lot?'<p>Subtotal do lote '+escape(lot)+': '+money.format(total(group))+'</p>':''}`).join('')}
  <p><strong>Valor total da proposta: ${money.format(total(items))}</strong></p><footer>Gerado pelo E-Lementar Licitações</footer></html>`;
}

function printProposal(row,items) {
  const frame = document.createElement('iframe');
  frame.title = 'Proposta comercial para impressão';
  frame.style.cssText = 'position:fixed;width:1px;height:1px;border:0;bottom:0';
  frame.onload = ()=>{
    frame.contentWindow.addEventListener('afterprint',()=>frame.remove(),{once:true});
    frame.contentWindow.print();
  };
  frame.srcdoc = proposalHtml(row,items,db.empresas.find(company=>company.id===row.empresa_id));
  document.body.append(frame);
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
  const docs = db.documentos.filter(x=>x.edital_id===row.id);
  const section = panel(view,'<h2>Proposta · '+escape(row.numero)+'</h2><p>'+escape(row.orgao)+' · '+escape(db.empresas.find(e=>e.id===row.empresa_id)?.nome)+'</p><p>Total estimado <strong>'+money.format(total(rows))+'</strong></p>');
  if (row.status==='Aprovado') {
    writeAction('Adicionar item',()=>item(row),section,true);
    writeAction('Importar planilha Excel',()=>importProposalItems(row),section);
    if (canWrite()) section.insertAdjacentHTML('beforeend',' <a href="./modelo-itens-proposta.xlsx" download>Baixar modelo Excel (.xlsx)</a>');
  }
  if (rows.length && row.empresa_id) action('Imprimir proposta',()=>printProposal(row,rows),section);
  const table = document.createElement('div');
  table.className = 'scroll';
  table.innerHTML = '<table><thead><tr><th>Lote</th><th>Item</th><th>Código interno</th><th>Descrição</th><th>Qtde.</th><th>Und.</th><th>Marca</th><th>Custo unitário</th><th>Margem</th><th>Fornecedor</th><th>Observação</th><th>Preço proposto</th><th>Total</th><th>Ações</th></tr></thead><tbody></tbody></table>';
  section.append(table);
  for (const entry of rows) {
    const tr = table.querySelector('tbody').insertRow();
    for (const value of [entry.lote,entry.codigo,catalogCode(entry),printedDescription(entry),entry.quantidade,entry.unidade,entry.marca,(entry.custo_embalagem/entry.embalagem).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:4}),entry.margem+'%',entry.fornecedor,entry.observacao,money.format(price(entry)),money.format(total([entry]))]) tr.insertCell().textContent=value;
    const controls=tr.insertCell();
    if(row.status==='Aprovado') writeAction('Editar',()=>item(row,entry),controls);
  }
  if (detailMode === 'docs') section.remove();
  if (detailMode === 'proposal') return;
  const checklist=panel(view,'<h2>Checklist documental</h2>');
  writeAction('Adicionar requisito',()=>documentEditor(row),checklist,true);
  for(const doc of docs){
    const card=panel(checklist,'<strong>'+escape(doc.nome)+'</strong><p>'+escape(doc.conferido?'Conferido':'Pendente')+(doc.validade?' · validade '+escape(doc.validade):'')+'</p>');
    writeAction('Conferir',()=>documentEditor(row,doc),card);
  }
  proposalAttachments(checklist,row,rows).catch(error=>{if(checklist.isConnected) message(error.message);});
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
