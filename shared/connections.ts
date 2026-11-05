import type {MethodId} from './payment-methods.js';

export type ConnectionProviderField={key:string;label:string;type:'text'|'password'|'textarea'|'select'|'url';required?:boolean;placeholder?:string;help?:string;options?:{value:string;label:string}[]};
export type ConnectionProviderDefinition={id:string;name:string;description:string;fields:ConnectionProviderField[];walletOptionIds:string[];modes:('live'|'test')[];verification:'automatic'|'manual';methods:MethodId[]};
export type ConnectionInput={provider:string;label?:string;mode:'live'|'test';fields:Record<string,string>};
export type ConnectionSummary={id:string;provider:string;label:string;mode:'live'|'test';status:'connected'|'manual'|'unavailable';detail:string;methods:MethodId[];createdAt:string;verifiedAt?:string};
export type ConnectionsView={providers:ConnectionProviderDefinition[];connections:ConnectionSummary[]};
