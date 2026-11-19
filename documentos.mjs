export const normalizeDocument=value=>String(value??'').toUpperCase().replace(/[^0-9A-Z]/g,'');
export const registerName=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
export function validDocument(value){const document=normalizeDocument(value);if(/^(.)\1+$/.test(document))return false;
 const digit=(chars,weights)=>{const sum=[...chars].reduce((n,c,i)=>n+(c.charCodeAt(0)-48)*weights[i],0),remainder=sum%11;return remainder<2?0:11-remainder};
 if(/^\d{11}$/.test(document)){const first=digit(document.slice(0,9),[10,9,8,7,6,5,4,3,2]);return first===Number(document[9])&&digit(document.slice(0,10),[11,10,9,8,7,6,5,4,3,2])===Number(document[10])}
 if(/^[0-9A-Z]{12}\d{2}$/.test(document)){const first=digit(document.slice(0,12),[5,4,3,2,9,8,7,6,5,4,3,2]);return first===Number(document[12])&&digit(document.slice(0,13),[6,5,4,3,2,9,8,7,6,5,4,3,2])===Number(document[13])}return false;
}
