// PostgreSQL monetary strings are never converted to IEEE floating point for display.
export function formatMoney(value){
 const match=/^(-?)(\d+)(?:\.(\d*))?$/.exec(String(value??'0'));
 if(!match)return String(value??'0');
 const whole=match[2].replace(/\B(?=(\d{3})+(?!\d))/g,',');
 const fraction=(match[3]||'').replace(/0+$/,'').padEnd(2,'0');
 return match[1]+whole+'.'+fraction;
}
// Human-facing balance labels only; raw input/API values keep their full precision.
export function formatBalance(value){
 const raw=String(value??'0'),match=/^(-?)(\d+)(?:\.(\d*))?$/.exec(raw);if(!match)return raw;
 const fraction=match[3]||'';let units=BigInt(match[2])*10000n+BigInt((fraction+'0000').slice(0,4));
 if((fraction[4]||'0')>='5')units+=1n;
 const sign=match[1]&&units!==0n?'-':'';
 return formatMoney(sign+(units/10000n).toString()+'.'+(units%10000n).toString().padStart(4,'0'));
}
