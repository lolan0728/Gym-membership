const dateTimeFormatter=new Intl.DateTimeFormat('en-CA',{
  timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
});

function parts(value:Date){
  return Object.fromEntries(dateTimeFormatter.formatToParts(value).map(part=>[part.type,part.value]));
}

export function formatBeijingDateTime(value:Date|string|number=new Date()){
  const p=parts(value instanceof Date?value:new Date(value));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function formatBeijingDate(value:Date|string|number=new Date()){
  const p=parts(value instanceof Date?value:new Date(value));
  return `${p.year}/${p.month}/${p.day}`;
}

export function beijingDay(value:Date|string|number=new Date()){
  return formatBeijingDate(value).replaceAll('/','-');
}

export function beijingMonth(value:Date|string|number=new Date()){
  const p=parts(value instanceof Date?value:new Date(value));
  return `${p.year}${p.month}`;
}

export function backupStamp(value:Date|string|number=new Date()){
  return formatBeijingDateTime(value).replace(/[/: ]/g,'');
}

export function normalizeExcelDate(value:string){return value.replaceAll('/','-').slice(0,10);}

export function normalizeExcelDateTime(value:string){
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value))return value;
  const match=value.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if(!match)return value;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`;
}
