export async function POST(request: Request) {
  const body: { customerId: string } = await request.json();
  return Response.json({ id: body.customerId }, { status: 201 });
}
