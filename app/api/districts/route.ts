import { DISTRICTS } from "../../../lib/idf-data";

export async function GET() {
  return Response.json({
    boundaryVersion: "PBS-2023",
    count: DISTRICTS.length,
    districts: DISTRICTS,
  });
}
