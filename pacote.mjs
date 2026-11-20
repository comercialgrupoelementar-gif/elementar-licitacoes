const encoder = new TextEncoder();
const crcTable = Uint32Array.from({length:256}, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

export function makeZip(files) {
  if (files.length > 65535) throw new Error('Quantidade de arquivos acima do limite do ZIP.');
  const parts = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const {name,bytes} of files) {
    const path = encoder.encode(name);
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    crc ^= 0xffffffff;
    const entry = new Uint8Array(30 + path.length);
    const local = new DataView(entry.buffer);
    local.setUint32(0,0x04034b50,true);
    local.setUint16(4,20,true);
    local.setUint16(6,0x800,true);
    local.setUint16(12,33,true);
    local.setUint32(14,crc,true);
    local.setUint32(18,bytes.length,true);
    local.setUint32(22,bytes.length,true);
    local.setUint16(26,path.length,true);
    entry.set(path,30);
    const central = new Uint8Array(46 + path.length);
    const metadata = new DataView(central.buffer);
    metadata.setUint32(0,0x02014b50,true);
    metadata.setUint16(4,20,true);
    central.set(entry.subarray(4,28),6);
    metadata.setUint32(42,offset,true);
    central.set(path,46);
    if (offset + entry.length + bytes.length + directorySize + central.length + 22 > 0xffffffff) {
      throw new Error('O pacote excede o limite do formato ZIP.');
    }
    parts.push(entry,bytes);
    directory.push(central);
    directorySize += central.length;
    offset += entry.length + bytes.length;
  }
  const end = new Uint8Array(22);
  const trailer = new DataView(end.buffer);
  trailer.setUint32(0,0x06054b50,true);
  trailer.setUint16(8,files.length,true);
  trailer.setUint16(10,files.length,true);
  trailer.setUint32(12,directorySize,true);
  trailer.setUint32(16,offset,true);
  return new Blob([...parts,...directory,end],{type:'application/zip'});
}
