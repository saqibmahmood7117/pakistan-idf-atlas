import {nativeArchiveRequest} from '../../../lib/native-subdaily-source';
export async function POST(request:Request){
 try{return Response.json(await nativeArchiveRequest(await request.json()));}
 catch(error){return Response.json({status:'error',error:error instanceof Error?error.message:'Native sub-daily extraction failed.'},{status:400});}
}
export const maxDuration=300;
