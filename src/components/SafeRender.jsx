import React from 'react';

class SafeRender extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        console.error("SafeRender caught an error:", error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback || <div style={{ padding: '10px', color: 'red', fontSize: '10px' }}>Render Error</div>;
        }

        return this.props.children;
    }
}

export default SafeRender;
