import html2canvas from 'html2canvas';

/**
 * Captures a DOM element and saves it as a JPEG image.
 * @param {string} elementId - The ID of the element to capture.
 * @param {string} fileName - The name of the file to save.
 */
export const saveAsJpeg = async (elementId, fileName = 'coupon.jpg') => {
    const element = document.getElementById(elementId);
    if (!element) {
        console.error(`Element with ID ${elementId} not found.`);
        return;
    }

    try {
        // Create canvas from element
        const canvas = await html2canvas(element, {
            backgroundColor: '#0f172a', // Default dark background from the app
            scale: 2, // Higher scale for better quality
            logging: false,
            useCORS: true,
            allowTaint: true,
        });

        // Convert to blob
        canvas.toBlob((blob) => {
            if (!blob) {
                console.error('Failed to create blob from canvas.');
                return;
            }
            // Create download link
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }, 'image/jpeg', 0.95);
    } catch (error) {
        console.error('Error saving image:', error);
    }
};
