
export const themes={azul:[20,64,112],verde:[18,94,77],vinho:[124,41,60]};
export const defaults={tema:'azul',detalhes:'sim',graficos:'sim'};
export function collectReport(view) {
 const tables=[...view.querySelectorAll('table')].filter(el=>el.getClientRects().length).map((table,index)=>{
   const rows=[...table.rows].filter(row=>row.getClientRects().length);
   const header=rows[0];
   const cols=header?[...header.cells].map((cell,i)=>({name:cell.innerText.trim(),i})).filter(c=>c.name&&!/^(ação|ações|acesso)$/i.test(c.name)):[];
   return {name:table.caption?.innerText||table.closest('section')?.querySelector('h2,h3')?.innerText||'Tabela '+(index+1),
     headers:cols.map(c=>c.name),rows:rows.slice(1).map(row=>cols.map(c=>row.cells[c.i]?.querySelector('meter')?.value?.toString()??row.cells[c.i]?.innerText.trim()??''))};
 }).filter(t=>t.headers.length&&t.rows.length);
 const notes=[...view.querySelectorAll('h2,h3,p,small,.metric')].filter(el=>el.getClientRects().length&&!el.closest('table')&&!el.closest('form')&&!el.querySelector('p,h2,h3')).map(el=>el.innerText.trim()).filter(Boolean);
 return {tables,notes};
}
function numeric(value) {
 const normalized=String(value??'').replace(/R\$|%|\s/g,'');
 if(!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(normalized)) return null;
 return Number(normalized.replaceAll('.','').replace(',','.'));
}
export function chartData(table,labelIndex,metric) {
 const byLabel=new Map();
 for(const row of table.rows) {
   const label=row[labelIndex]||'Sem classificação';
   const n=metric==='count'?1:numeric(row[Number(metric)]);
   if(n===null) continue;
   byLabel.set(label,(byLabel.get(label)??0)+n);
 }
 return [...byLabel].sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
}
export function renderExecutivePdf(pdf,{title,issuer,date,summary,theme,details,report,charts}) {
 const rgb=themes[theme]??themes.azul, width=182;
 let y;
 function page(first) {
   if(!first) pdf.addPage();
   pdf.setFillColor(...rgb);pdf.rect(0,0,210,first?47:24,'F');
   pdf.setTextColor(255);pdf.setFont('helvetica','bold');pdf.setFontSize(first?19:12);
   const heading=pdf.splitTextToSize(title,width).slice(0,2);
   pdf.text(heading,14,first?19:11);
   if(first) {pdf.setFont('helvetica','normal');pdf.setFontSize(9);pdf.text('Relatório executivo  |  '+date,14,41);}
   y=first?58:34;pdf.setTextColor(24,34,46);
 }
 function space(h){if(y+h>279)page(false);}
 function line(value,size=10,bold=false) {
   pdf.setFont('helvetica',bold?'bold':'normal');pdf.setFontSize(size);
   for(const row of pdf.splitTextToSize(String(value),width)){space(size*.47+1);pdf.text(row,14,y);y+=size*.47+1;}
 }
 function section(label){space(16); y+=4; line(label,13,true); y+=2;}
 page(true);
 if(issuer) line(issuer,11,true);
 if(summary){section('Resumo executivo');line(summary);}
 const count=report.tables.reduce((sum,t)=>sum+t.rows.length,0);
 space(22);pdf.setFillColor(233,240,246);pdf.roundedRect(14,y,182,17,2,2,'F');y+=10;
 line(count+' registros em '+report.tables.length+' tabelas  |  '+charts.length+' gráficos',11,true);y+=8;
 if(report.notes.length){section('Indicadores e contexto da tela');for(const note of report.notes.slice(0,18)) line(note,9);}
 for(const chart of charts) {
   const rows=chart.rows.slice(0,8);
   space(20+rows.length*11);section(chart.title);
   if(!rows.length){line('Sem valores para este gráfico.');continue;}
   const max=Math.max(1,...rows.map(([,v])=>Math.abs(v)));
   pdf.setFont('helvetica','normal');pdf.setFontSize(8);
   for(const [label,value] of rows) {
     pdf.text(pdf.splitTextToSize(label,65)[0],14,y);
     pdf.setFillColor(234,238,242);pdf.rect(81,y-3,82,4,'F');
     pdf.setFillColor(...(value<0?[170,56,70]:rgb));pdf.rect(81,y-3,82*Math.abs(value)/max,4,'F');
     pdf.text(new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2}).format(value),196,y,{align:'right'});y+=9;
   }
   if(chart.rows.length>8)line('Exibidos os 8 maiores valores em magnitude.',8);
 }
 if(details) for(const table of report.tables) {
   section(table.name);
   const n=table.headers.length;
   const w=width/n;
   function writeRow(row,header,index=0){
     pdf.setFont('helvetica',header?'bold':'normal');pdf.setFontSize(8);
     const cells=row.map(value=>pdf.splitTextToSize(String(value),w-3));
     const lines=Math.max(1,...cells.map(cell=>cell.length));
     for(let offset=0;offset<lines;) {
       if(y+8>279){page(false);if(!header)writeRow(table.headers,true);}
       const chunk=Math.min(lines-offset,Math.max(1,Math.floor((279-y-4)/3.6)));
       const h=chunk*3.6+4;
       pdf.setFont('helvetica',header?'bold':'normal');pdf.setFontSize(8);
       pdf.setFillColor(...(header?rgb:index%2?[240,245,249]:[250,251,252]));pdf.rect(14,y,width,h,'F');
       pdf.setTextColor(header?255:23,header?255:34,header?255:46);
       cells.forEach((cell,i)=>{const part=cell.slice(offset,offset+chunk);if(part.length)pdf.text(part,15+i*w,y+4);});
       y+=h;offset+=chunk;
     }
     pdf.setTextColor(24,34,46);
   }
   writeRow(table.headers,true);
   table.rows.forEach((row,i)=>writeRow(row,false,i));
 }
 const pages=pdf.getNumberOfPages();
 for(let i=1;i<=pages;i++){pdf.setPage(i);pdf.setDrawColor(204,216,225);pdf.line(14,284,196,284);pdf.setFontSize(8);pdf.setTextColor(65,77,90);pdf.text('E-Lementar Licitações  |  '+date,14,290);pdf.text(i+' / '+pages,196,290,{align:'right'});}
}
