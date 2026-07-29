import '@shopify/ui-extensions/preact';
import { render } from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  function handleClick() {
    shopify.navigation.navigate("extension:customer-subscriptions-dashboard");
  }

  return (
    <s-section heading="My Subscriptions">
      <s-stack gap="base">
        <s-text>view your active subscriptions and manage them.</s-text>
        <s-button onClick={handleClick}>
          Subscriptions
        </s-button>
      </s-stack>
    </s-section>
  );
}
