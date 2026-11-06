import type {InvoiceDraft} from './invoice-options.js';
import {paymentDueDate} from './payment-terms.js';

export type RecurringFrequency={type:'monthly'}|{type:'days';intervalDays:number};
export interface RecurringPlan {
 id:string;label:string;templateId:string;templateLabel:string;templateDraft:InvoiceDraft;
 startDate:string;frequency:RecurringFrequency;dueOffsetDays?:number;paused:boolean;createdAt:string;updatedAt:string;
}
export interface RecurringDraft {
 id:string;planId:string;planLabel:string;periodIndex:number;periodDate:string;
 status:'draft'|'issued';draft:InvoiceDraft;createdAt:string;invoiceId?:string;issuedAt?:string;
}
export interface RecurringPrepareResult {drafts:RecurringDraft[];createdCount:number;hasMore:boolean;asOf:string}
/** UTC calendar recurrence anchored to the original start date, including month-end. */
export function occurrenceDate(startDate:string,frequency:RecurringFrequency,index:number):string|undefined {
 paymentDueDate(startDate,0);
 if(!Number.isSafeInteger(index)||index<0)throw new RangeError('Invalid recurrence period.');
 if(frequency.type==='days'){
  if(!Number.isSafeInteger(frequency.intervalDays)||frequency.intervalDays<1||frequency.intervalDays>3650)throw new RangeError('Invalid recurrence interval.');
  const days=frequency.intervalDays*index;if(!Number.isSafeInteger(days))return undefined;
  // The terms helper intentionally bounds terms to ten years; recurrence may span longer.
  const parsed=new Date(startDate+'T00:00:00Z');parsed.setUTCDate(parsed.getUTCDate()+days);
  return Number.isFinite(parsed.getTime())&&parsed.getUTCFullYear()<=9999?parsed.toISOString().slice(0,10):undefined;
 }
 const [year,month,day]=startDate.split('-').map(Number),monthIndex=year*12+month-1+index;
 if(!Number.isSafeInteger(monthIndex)||monthIndex>=120000)return undefined;
 const nextYear=Math.floor(monthIndex/12),nextMonth=monthIndex%12;
 const result=new Date(startDate+'T00:00:00Z');result.setUTCFullYear(nextYear,nextMonth+1,0);
 result.setUTCDate(Math.min(day,result.getUTCDate()));
 return result.toISOString().slice(0,10);
}
