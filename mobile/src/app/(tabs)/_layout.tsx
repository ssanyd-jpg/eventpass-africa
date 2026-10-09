import { Tabs } from "expo-router";
import { Text } from "react-native";

function Icon({ label }: { label: string }) {
  return <Text style={{ fontSize: 22 }}>{label}</Text>;
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#1f2937",
          borderTopColor: "#374151",
          paddingBottom: 6,
          height: 64,
        },
        tabBarActiveTintColor: "#10b981",
        tabBarInactiveTintColor: "#6b7280",
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="scan"
        options={{
          title: "Gate",
          tabBarIcon: ({ focused }) => (
            <Icon label={focused ? "🟢" : "⬜"} />
          ),
        }}
      />
      <Tabs.Screen
        name="provision"
        options={{
          title: "Provision",
          tabBarIcon: ({ focused }) => (
            <Icon label={focused ? "📲" : "📳"} />
          ),
        }}
      />
      <Tabs.Screen
        name="vendor"
        options={{
          title: "Vendor",
          tabBarIcon: ({ focused }) => (
            <Icon label={focused ? "💳" : "🪙"} />
          ),
        }}
      />
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ focused }) => (
            <Icon label={focused ? "📊" : "📈"} />
          ),
        }}
      />
    </Tabs>
  );
}
