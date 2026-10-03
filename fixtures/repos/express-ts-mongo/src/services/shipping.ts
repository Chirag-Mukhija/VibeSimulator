import axios from "axios";

const shippingApi = axios.create({ baseURL: "https://api.shipfast.example", timeout: 5000 });

export async function quote(items: unknown[]) {
  const { data } = await shippingApi.post("/quotes", { items });
  return data;
}

export async function track(orderId: string) {
  const { data } = await axios.get(`https://tracking.example.com/v1/${orderId}`);
  return data;
}
