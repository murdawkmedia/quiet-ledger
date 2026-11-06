/** Calendar days from the issued YYYY-MM-DD date, independent of timezone/DST. */
export function paymentDueDate(issueDate:string,days:number):string{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)||!Number.isSafeInteger(days)||days<0||days>3650)throw new Error('Enter a valid issue date and whole payment-term days from 0 to 3650.');
 const value=new Date(issueDate+'T00:00:00Z');
 if(!Number.isFinite(value.getTime())||value.toISOString().slice(0,10)!==issueDate)throw new Error('Enter a valid calendar issue date.');
 value.setUTCDate(value.getUTCDate()+days);const due=value.toISOString().slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(due))throw new Error('Payment terms exceed the supported calendar range.');
 return due;
}
