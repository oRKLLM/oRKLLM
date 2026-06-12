import fs from 'fs';
const shapes = {'base(4,32,16)':'4_32_16','M=8':'8_32_16','K=64':'4_64_16','N=32':'4_32_32'};
function parse(f){
  const txt=fs.readFileSync(f,'utf8');
  const words=[];
  for(const ln of txt.split('\n')){
    const m=ln.match(/^\s*\[\d+\]\s+(.*)$/); if(!m)continue;
    for(const h of m[1].trim().split(/\s+/)) if(/^[0-9a-f]{8}$/.test(h)) words.push(parseInt(h,16));
  }
  const regs={};
  for(let k=0;k+1<words.length;k+=2){
    const w0=words[k],w1=words[k+1];
    const off=w0&0xffff, block=w1>>>16, val=(((w1&0xffff)>>>0)<<16 | (w0>>>16))>>>0;
    regs[`${block.toString(16)}:${off.toString(16)}`]={block,off,val};
  }
  return regs;
}
const data={}; for(const[k,v]of Object.entries(shapes)) data[k]=parse(`/tmp/rc_${v}.txt`);
const keys=Object.keys(data); const base=data[keys[0]];
// collect all reg ids
const allregs=new Set(); for(const d of Object.values(data)) Object.keys(d).forEach(r=>allregs.add(r));
console.log('reg(block:off)   '+keys.map(k=>k.padEnd(13)).join(''));
const isAddr=v=>(v>>>0)>=0xffff0000||((v>>>0)>=0xfff00000&&(v>>>0)<=0xffffffff);
for(const r of [...allregs].sort()){
  const vals=keys.map(k=>data[k][r]?data[k][r].val>>>0:null);
  const uniq=new Set(vals.map(v=>v===null?'-':v.toString(16)));
  if(uniq.size>1){
    // skip pure-address regs (vary by allocation, not dims)
    const addrish=vals.every(v=>v===null||isAddr(v));
    const tag=addrish?'  <ADDR>':'';
    console.log(r.padEnd(16)+vals.map(v=>(v===null?'-':'0x'+v.toString(16)).padEnd(13)).join('')+tag);
  }
}
