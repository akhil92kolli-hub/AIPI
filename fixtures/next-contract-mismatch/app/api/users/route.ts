import { z } from "zod";

const createUserSchema = z.object({
  customerId: z.string().uuid(),
});

export async function POST(request: Request) {
  const body = createUserSchema.parse(await request.json());
  return Response.json({ id: body.customerId }, { status: 201 });
}
