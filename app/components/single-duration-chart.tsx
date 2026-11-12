import {useState} from "react";
import type { ResultRow } from "../../lib/observed-idf";

/** With one duration, frequency is the varying independent coordinate. */
export default function SingleDurationChart({rows,axis,svgId,intensityUnit="mm/hr"}:{rows:ResultRow[];axis:"linear"|"log";svgId:string;intensityUnit?:"mm/hr"|"inch/hr"}) {
  const [hoverPeriod,setHoverPeriod]=useState<number|null>(null);
  const unique=new Map<number,ResultRow>();
  for(const row of rows)if(Number.isFinite(row.intensityMmHr)&&row.intensityMmHr>=0&&row.returnPeriodYears>1)unique.set(row.returnPeriodYears,row);
  const points=[...unique.values()].sort((a,b)=>a.returnPeriodYears-b.returnPeriodYears);
  if(!points.length)return null;
  const hoverRow=points.find(row=>row.returnPeriodYears===hoverPeriod);
  const duration=points[0].durationMinutes;
  const label=duration===1440?"24-hour":`${duration}-minute`;
  const w=800,h=440,m={left:112,right:34,top:64,bottom:76};
  const max=Math.max(1,...points.map(row=>row.intensityMmHr))*1.15;
  const positive=points.filter(row=>row.intensityMmHr>0).map(row=>row.intensityMmHr);
  const min=Math.max(.001,(positive.length?Math.min(...positive):.001)*.7);
  const log=axis==="log"&&positive.length===points.length;
  const low=Math.min(...points.map(row=>row.returnPeriodYears))/1.15,high=Math.max(...points.map(row=>row.returnPeriodYears))*1.15;
  const x=(period:number)=>m.left+(Math.log(period/low)/Math.log(high/low))*(w-m.left-m.right);
  const y=(intensity:number)=>log?m.top+(1-(Math.log(Math.max(min,intensity))-Math.log(min))/(Math.log(max)-Math.log(min)))*(h-m.top-m.bottom):m.top+(1-intensity/max)*(h-m.top-m.bottom);
  const ticks=Array.from({length:6},(_,index)=>log?Math.exp(Math.log(min)+(Math.log(max)-Math.log(min))*index/5):max*index/5);
  return <div className="chartbox" data-testid="single-duration-chart">
    <div className="chart-title"><strong>{label} rainfall frequency curve</strong><span>One duration · compare return periods</span></div>
    <div className="single-duration-scroll"><svg id={svgId} viewBox={`0 0 ${w} ${h}`} onPointerLeave={()=>setHoverPeriod(null)} onPointerMove={event=>{const svg=event.currentTarget,matrix=svg.getScreenCTM();if(!matrix)return;const p=svg.createSVGPoint();p.x=event.clientX;p.y=event.clientY;const cursor=p.matrixTransform(matrix.inverse());if(cursor.x<m.left||cursor.x>w-m.right||cursor.y<m.top||cursor.y>h-m.bottom){setHoverPeriod(null);return;}const nearest=points.reduce((best,row)=>(x(row.returnPeriodYears)-cursor.x)**2+(y(row.intensityMmHr)-cursor.y)**2<(x(best.returnPeriodYears)-cursor.x)**2+(y(best.intensityMmHr)-cursor.y)**2?row:best);setHoverPeriod(nearest.returnPeriodYears);}} role="group" aria-label={`${label} rainfall intensity against return period`} style={{fontFamily:"Arial, Helvetica, sans-serif"}}>
      <rect width={w} height={h} fill="white" rx="10"/>
      <text x={m.left} y="24" fontSize="13" fontWeight="700" fill="#173b5c">{label} rainfall · return-period comparison</text>
      <text x={m.left} y="43" fontSize="10" fill="#607681">Only this duration is supported. A multi-duration IDF equation is not fitted.</text>
      <rect x={m.left} y={m.top} width={w-m.left-m.right} height={h-m.top-m.bottom} fill="#f5fafb" stroke="#b9cdd2" rx="5"/>
      {ticks.map((tick,index)=><g key={index}><line x1={m.left} x2={w-m.right} y1={y(tick)} y2={y(tick)} stroke="#cfdee3" strokeDasharray="4 4"/><text x={m.left-10} y={y(tick)+4} textAnchor="end" fontSize="11" fill="#536b77">{tick.toFixed(tick<1?4:2)}</text></g>)}
      {points.map(row=><g key={row.returnPeriodYears}><line x1={x(row.returnPeriodYears)} x2={x(row.returnPeriodYears)} y1={m.top} y2={h-m.bottom} stroke="#d6e4e7" strokeDasharray="3 5"/><text x={x(row.returnPeriodYears)} y={h-m.bottom+24} textAnchor="middle" fontSize="11" fill="#536b77">{row.returnPeriodYears}</text></g>)}
      <polyline points={points.map(row=>`${x(row.returnPeriodYears)},${y(row.intensityMmHr)}`).join(" ")} fill="none" stroke="#087f88" strokeWidth="3"/>
      {points.map(row=><g key={`value-${row.returnPeriodYears}`}><circle tabIndex={0} role="button" aria-label={`${row.returnPeriodYears}-year: ${row.intensityMmHr.toFixed(4)} ${intensityUnit}`} onFocus={()=>setHoverPeriod(row.returnPeriodYears)} onClick={()=>setHoverPeriod(row.returnPeriodYears)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setHoverPeriod(row.returnPeriodYears);}}} cx={x(row.returnPeriodYears)} cy={y(row.intensityMmHr)} r={hoverPeriod===row.returnPeriodYears?8:5} fill="white" stroke="#087f88" strokeWidth="2"><title>{`${row.returnPeriodYears}-year · ${row.intensityMmHr.toFixed(4)} ${intensityUnit} · ${row.depthMm.toFixed(2)} mm depth`}</title></circle><text x={x(row.returnPeriodYears)} y={y(row.intensityMmHr)-11} textAnchor="middle" fontSize="10" fontWeight="700" fill="#173b5c">{row.intensityMmHr.toFixed(2)}</text></g>)}
      <text x={w/2} y={h-22} textAnchor="middle" fontSize="13" fontWeight="700" fill="#294958">Return period (years · logarithmic spacing)</text>
      <text transform={`rotate(-90 22 ${h/2})`} x="22" y={h/2} textAnchor="middle" fontSize="12" fontWeight="700" fill="#294958">Rainfall intensity ({intensityUnit})</text>
    </svg></div>
    <p role="status" aria-live="polite">{hoverRow ? `${hoverRow.returnPeriodYears}-year · ${duration} minutes · ${hoverRow.intensityMmHr.toFixed(4)} ${intensityUnit}` : "Move the cursor or focus a point to inspect the nearest plotted value."}</p>
    <p className="report-note">These are {label} return levels, not an empty duration curve. Shorter-duration curves require suitable duration data or an explicitly selected scaling assumption.</p>
  </div>;
}
