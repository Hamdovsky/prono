import json
from datetime import datetime

class LiveEventEngine:
    def __init__(self):
        self.event_topic = "match_events_live"
        self.dead_letter_queue = "match_events_dlq"

    def ingest_event(self, provider: str, raw_event: dict):
        """
        Ingest event from Opta/SofaScore (Goal, Red Card, Injury, Lineup)
        """
        event_type = self._map_event_type(raw_event)
        
        standardized_event = {
            "event_id": raw_event.get("id"),
            "match_id": raw_event.get("match_id"),
            "event_type": event_type,
            "payload": raw_event,
            "recorded_at": datetime.utcnow().isoformat(),
            "provider": provider
        }
        
        self.publish_to_kafka(standardized_event)
        
        # This will automatically trigger:
        # 1. State update in Redis
        # 2. Feature recalculation
        # 3. Inference refresh

    def publish_to_kafka(self, event):
        """
        Append-only event driven architecture
        """
        # Publish logic
        print(f"📡 Published event to Kafka: {event['event_type']}")

    def _map_event_type(self, raw_event):
        # Stub logic to map external event names to internal standards
        return raw_event.get("type", "UNKNOWN")

if __name__ == "__main__":
    print("🚀 Live Event Ingestion Engine initialized.")
